/** Typed wrappers for every command in `.context/commands.md`, over `Transport`. */
import { getTransport } from './transport';
import type {
  AddProjectRequest,
  AgentStatus,
  AppInfo,
  AskRequest,
  BlobResponse,
  Bootstrap,
  BootstrapScope,
  CommandError,
  CommitSuggestionsRequest,
  ConflictFile,
  DelegateRequest,
  DeviceLogin,
  DraftStateRequest,
  EditCommentRequest,
  FileRequest,
  FindSymbolRequest,
  GetBlobRequest,
  HostAuthStatus,
  HostKind,
  InterdiffEntry,
  InterdiffRequest,
  HostRepo,
  LinearIssue,
  LinearIssuesRequest,
  LinearStatus,
  LocalBranch,
  LoginState,
  MergeInfo,
  MergeRequest,
  OpenBranchRequest,
  OpenPrRequest,
  OpenPrResponse,
  Person,
  PrId,
  PrSpend,
  Project,
  ProjectWorkingState,
  ReactRequest,
  ReplyRequest,
  RerunCheckRequest,
  Revision,
  RevisionRequest,
  ResolveRequest,
  ReviewersRequest,
  RunSkillRequest,
  SandboxFaultRequest,
  SandboxStatus,
  SaveSkillRequest,
  SetLinearTokenRequest,
  SetTokenRequest,
  SkillBody,
  SkillInfo,
  SubmitReviewRequest,
  SymbolHit,
  SyncFrame,
  TaskDecision,
  Transaction,
  TransactionResult,
  TriageRequest,
  UpdateInfo,
} from '../gen/contract';

/** A command rejected; carries the core's error code, not just a message. */
export class CommandFailure extends Error {
  readonly code: string;
  constructor(err: CommandError) {
    super(err.message);
    this.name = 'CommandFailure';
    this.code = err.code;
  }
}

/** Set once by `RootStore.start()`. Every rejected command surfaces here as a
 *  toast — callers that also need to adjust their own state (clear a busy
 *  flag, roll back an optimistic update) still get the rejection to `catch`,
 *  they just don't need to put the message in front of the user themselves. */
let onFailure: ((f: CommandFailure) => void) | null = null;

export function setCommandFailureHandler(
  fn: (f: CommandFailure) => void,
): void {
  onFailure = fn;
}

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await getTransport().invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
      const failure = new CommandFailure(e as CommandError);
      onFailure?.(failure);
      throw failure;
    }
    throw e;
  }
}

export const api = {
  bootstrap: (scope: BootstrapScope) => call<Bootstrap>('bootstrap', { scope }),
  catchUp: (since: number) => call<SyncFrame>('catch_up', { since }),
  transact: (tx: Transaction) => call<TransactionResult>('transact', { tx }),
  openPr: (req: OpenPrRequest) => call<OpenPrResponse>('open_pr', { req }),
  getRevision: (req: RevisionRequest) =>
    call<Revision>('get_revision', { req }),
  getFile: (req: FileRequest) => call<string | null>('get_file', { req }),
  regroup: (pr: PrId) => call<null>('regroup', { pr }),
  runSkill: (req: RunSkillRequest) => call<string>('run_skill', { req }),
  ask: (req: AskRequest) => call<string>('ask', { req }),
  cancelRun: (run: string) => call<null>('cancel_run', { run }),
  submitReview: (req: SubmitReviewRequest) =>
    call<null>('submit_review', { req }),
  detectAgents: () => call<AgentStatus[]>('detect_agents'),
  appInfo: () => call<AppInfo>('app_info'),
  checkUpdate: () => call<UpdateInfo | null>('check_update'),
  installUpdate: () => call<null>('install_update'),
  refreshInbox: () => call<null>('refresh_inbox'),
  viewer: () => call<Person>('viewer'),
  hostStatus: () => call<HostAuthStatus>('host_status'),
  hostStatusFor: (host: HostKind) =>
    call<HostAuthStatus>('host_status_for', { host }),
  setHostToken: (req: SetTokenRequest) =>
    call<HostAuthStatus>('set_host_token', { req }),
  replyThread: (req: ReplyRequest) => call<null>('reply_thread', { req }),
  resolveThread: (req: ResolveRequest) => call<null>('resolve_thread', { req }),
  listSkills: (pr: PrId | null) => call<SkillInfo[]>('list_skills', { pr }),
  delegateTask: (req: DelegateRequest) =>
    call<string>('delegate_task', { req }),
  decideTask: (req: TaskDecision) => call<null>('decide_task', { req }),
  listHostRepos: () => call<HostRepo[]>('list_host_repos'),
  addProject: (req: AddProjectRequest) => call<Project>('add_project', { req }),
  removeProject: (id: string) => call<null>('remove_project', { id }),
  refreshProject: (id: string) => call<null>('refresh_project', { id }),
  listBranches: (project: string) =>
    call<LocalBranch[]>('list_branches', { project }),
  openBranch: (req: OpenBranchRequest) =>
    call<OpenPrResponse>('open_branch', { req }),
  /** `null` when the folder can't be read (moved, not a repo anymore, a
   *  core without git): the header just leaves the working state out, no
   *  toast for a passive read. */
  projectWorkingState: (project: string): Promise<ProjectWorkingState | null> =>
    getTransport()
      .invoke<ProjectWorkingState>('project_working_state', { project })
      .catch(() => null),
  mergeInfo: (pr: PrId) => call<MergeInfo>('merge_info', { pr }),
  mergePr: (req: MergeRequest) => call<null>('merge_pr', { req }),
  assignableUsers: (pr: PrId) => call<Person[]>('assignable_users', { pr }),
  setReviewers: (req: ReviewersRequest) => call<null>('set_reviewers', { req }),
  setDraft: (req: DraftStateRequest) => call<null>('set_draft', { req }),
  updateBranch: (pr: PrId) => call<null>('update_branch', { pr }),
  react: (req: ReactRequest) => call<null>('react', { req }),
  editComment: (req: EditCommentRequest) => call<null>('edit_comment', { req }),
  commitSuggestions: (req: CommitSuggestionsRequest) =>
    call<null>('commit_suggestions', { req }),
  getSkill: (id: string, pr: PrId | null) =>
    call<SkillBody>('get_skill', { id, pr }),
  saveSkill: (req: SaveSkillRequest) => call<SkillInfo>('save_skill', { req }),
  prSpend: (pr: PrId) => call<PrSpend>('pr_spend', { pr }),
  pickFolder: () => call<string | null>('pick_folder'),
  interdiff: (req: InterdiffRequest) =>
    call<InterdiffEntry[]>('interdiff', { req }),
  loginStart: () => call<DeviceLogin>('login_start'),
  loginPoll: () => call<LoginState>('login_poll'),
  rerunCheck: (req: RerunCheckRequest) => call<null>('rerun_check', { req }),
  triage: (req: TriageRequest) => call<null>('triage', { req }),
  setLinearToken: (req: SetLinearTokenRequest) =>
    call<LinearStatus>('set_linear_token', { req }),
  linearStatus: () => call<LinearStatus>('linear_status'),
  linearIssues: (req: LinearIssuesRequest) =>
    call<LinearIssue[]>('linear_issues', { req }),
  findSymbol: (req: FindSymbolRequest) =>
    call<SymbolHit[]>('find_symbol', { req }),
  getBlob: (req: GetBlobRequest) => call<BlobResponse>('get_blob', { req }),
  /** Settings → Sandbox: `null` outside sandbox mode. */
  sandboxStatus: () => call<SandboxStatus | null>('sandbox_status'),
  sandboxSetFault: (req: SandboxFaultRequest) =>
    call<SandboxStatus>('sandbox_set_fault', { req }),
  sandboxFireEvent: (id: string) =>
    call<SandboxStatus>('sandbox_fire_event', { id }),
  /** `null` means "can't tell" (an old local `git`, code `unsupported`) —
   *  the Merge dialog hides the list instead of toasting a routine
   *  degrade; any other failure still toasts like every other command. */
  conflicts: async (pr: PrId): Promise<ConflictFile[] | null> => {
    try {
      return await getTransport().invoke<ConflictFile[]>('conflicts', { pr });
    } catch (e) {
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        (e as CommandError).code === 'unsupported'
      ) {
        return null;
      }
      if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
        const failure = new CommandFailure(e as CommandError);
        onFailure?.(failure);
        throw failure;
      }
      throw e;
    }
  },
};
