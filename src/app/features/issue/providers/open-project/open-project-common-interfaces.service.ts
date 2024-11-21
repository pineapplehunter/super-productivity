import { Injectable } from '@angular/core';
import { Observable, of, timer } from 'rxjs';
import { Task } from 'src/app/features/tasks/task.model';
import { concatMap, map, switchMap } from 'rxjs/operators';
import { IssueServiceInterface } from '../../issue-service-interface';
import { OpenProjectApiService } from './open-project-api.service';
import { IssueProviderOpenProject, SearchResultItem } from '../../issue.model';
import { OpenProjectCfg } from './open-project.model';
import {
  OpenProjectWorkPackage,
  OpenProjectWorkPackageReduced,
} from './open-project-issue/open-project-issue.model';
import { isOpenProjectEnabled } from './is-open-project-enabled.util';
import {
  OPEN_PROJECT_INITIAL_POLL_DELAY,
  OPEN_PROJECT_POLL_INTERVAL,
} from './open-project.const';
import { parseOpenProjectDuration } from './open-project-view-components/parse-open-project-duration.util';
import {
  formatOpenProjectWorkPackageSubject,
  formatOpenProjectWorkPackageSubjectForSnack,
} from './format-open-project-work-package-subject.util';
import { IssueProviderService } from '../../issue-provider.service';

@Injectable({
  providedIn: 'root',
})
export class OpenProjectCommonInterfacesService implements IssueServiceInterface {
  constructor(
    private readonly _openProjectApiService: OpenProjectApiService,
    private readonly _issueProviderService: IssueProviderService,
  ) {}

  pollTimer$: Observable<number> = timer(
    OPEN_PROJECT_INITIAL_POLL_DELAY,
    OPEN_PROJECT_POLL_INTERVAL,
  );

  isBacklogPollingEnabledForDefaultProjectOnce$(
    issueProviderId: string,
  ): Observable<boolean> {
    return this._getCfgOnce$(issueProviderId).pipe(
      map(
        (cfg) => this.isEnabled(cfg) && cfg.isAutoAddToBacklog && !!cfg.defaultProjectId,
      ),
    );
  }

  isAutoUpdateIssuesEnabledOnce$(issueProviderId: string): Observable<boolean> {
    return this._getCfgOnce$(issueProviderId).pipe(
      map((cfg) => this.isEnabled(cfg) && cfg.isAutoPoll),
    );
  }

  isEnabled(cfg: OpenProjectCfg): boolean {
    return isOpenProjectEnabled(cfg);
  }

  issueLink$(issueId: number, issueProviderId: string): Observable<string> {
    return this._getCfgOnce$(issueProviderId).pipe(
      map((cfg) => `${cfg.host}/projects/${cfg.projectId}/work_packages/${issueId}`),
    );
  }

  getById$(issueId: number, issueProviderId: string): Observable<OpenProjectWorkPackage> {
    return this._getCfgOnce$(issueProviderId).pipe(
      concatMap((openProjectCfg) =>
        this._openProjectApiService.getById$(issueId, openProjectCfg),
      ),
    );
  }

  searchIssues$(
    searchTerm: string,
    issueProviderId: string,
  ): Observable<SearchResultItem[]> {
    return this._getCfgOnce$(issueProviderId).pipe(
      switchMap((openProjectCfg) =>
        this.isEnabled(openProjectCfg) && openProjectCfg.isSearchIssuesFromOpenProject
          ? this._openProjectApiService.searchIssueForRepo$(searchTerm, openProjectCfg)
          : of([]),
      ),
    );
  }

  async getFreshDataForIssueTask(task: Task): Promise<{
    taskChanges: Partial<Task>;
    issue: OpenProjectWorkPackage;
    issueTitle: string;
  } | null> {
    if (!task.issueProviderId) {
      throw new Error('No issueProviderId');
    }
    if (!task.issueId) {
      throw new Error('No issueId');
    }
    const cfg = await this._getCfgOnce$(task.issueProviderId).toPromise();
    const issue = await this._openProjectApiService
      .getById$(+task.issueId, cfg)
      .toPromise();

    const lastRemoteUpdate = new Date(issue.updatedAt).getTime();
    const wasUpdated = lastRemoteUpdate > (task.issueLastUpdated || 0);

    if (wasUpdated) {
      return {
        taskChanges: {
          ...this.getAddTaskData(issue),
          issueWasUpdated: true,
        },
        issue,
        issueTitle: formatOpenProjectWorkPackageSubjectForSnack(issue),
      };
    }
    return null;
  }

  async getFreshDataForIssueTasks(
    tasks: Task[],
  ): Promise<
    { task: Task; taskChanges: Partial<Task>; issue: OpenProjectWorkPackage }[]
  > {
    return Promise.all(
      tasks.map((task) =>
        this.getFreshDataForIssueTask(task).then((refreshDataForTask) => ({
          task,
          refreshDataForTask,
        })),
      ),
    ).then((items) => {
      return items
        .filter(({ refreshDataForTask, task }) => !!refreshDataForTask)
        .map(({ refreshDataForTask, task }) => {
          if (!refreshDataForTask) {
            throw new Error('No refresh data for task js error');
          }
          return {
            task,
            taskChanges: refreshDataForTask.taskChanges,
            issue: refreshDataForTask.issue,
          };
        });
    });
  }

  getAddTaskData(
    issue: OpenProjectWorkPackageReduced,
  ): Partial<Task> & { title: string } {
    const parsedEstimate: number = parseOpenProjectDuration(
      issue.estimatedTime as string | number | null,
    );

    return {
      title: formatOpenProjectWorkPackageSubject(issue),
      issuePoints: issue.storyPoints,
      issueWasUpdated: false,
      // NOTE: we use Date.now() instead to because updated does not account for comments
      issueLastUpdated: new Date(issue.updatedAt).getTime(),
      ...(parsedEstimate > 0 ? { timeEstimate: parsedEstimate } : {}),
    };
  }

  async getNewIssuesToAddToBacklog(
    issueProviderId: string,
    allExistingIssueIds: number[] | string[],
  ): Promise<OpenProjectWorkPackageReduced[]> {
    const cfg = await this._getCfgOnce$(issueProviderId).toPromise();
    console.log(
      await this._openProjectApiService
        .getLast100WorkPackagesForCurrentOpenProjectProject$(cfg)
        .toPromise(),
    );

    return await this._openProjectApiService
      .getLast100WorkPackagesForCurrentOpenProjectProject$(cfg)
      .toPromise();
  }

  private _getCfgOnce$(issueProviderId: string): Observable<IssueProviderOpenProject> {
    return this._issueProviderService.getCfgOnce$(issueProviderId, 'OPEN_PROJECT');
  }
}
