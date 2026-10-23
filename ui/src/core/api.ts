/** Typed wrappers for every command in `.context/commands.md`, over `Transport`. */
import { getTransport } from './transport';
import type {
  AccountSignInRequest,
  AccountSignInStart,
  AccountSignInState,
  AccountStatus,
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
  CreateSpaceRequest,
  ShipSpaceRequest,
  Space,
  SpaceFeedbackRequest,
  SpaceReviewRequest,
  SpaceSendRequest,
  SpaceConfigView,
  SpaceLogLine,
  SpaceRunRequest,
  SpaceSetupRequest,
  SpaceTrustRequest,
  EffectiveConfig,
  GlobalConfigInfo,
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
  /** The caller shows the failure itself (the sign-in dialog): no toast. */
  quiet = false,
): Promise<T> {
  try {
    return await getTransport().invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
      const failure = new CommandFailure(e as CommandError);
      if (!quiet) onFailure?.(failure);
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
  closeBranchReview: (pr: PrId) => call<null>('close_branch_review', { pr }),
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
  // ── spaces (docs/spaces.md; hidden behind build mode) ──
  createSpace: (req: CreateSpaceRequest) =>
    call<Space>('create_space', { req }),
  listSpaces: (project: string | null) =>
    call<Space[]>('list_spaces', { project }),
  spaceSend: (req: SpaceSendRequest) => call<string>('space_send', { req }),
  spaceStop: (space: string) => call<null>('space_stop', { space }),
  spaceReview: (req: SpaceReviewRequest) =>
    call<OpenPrResponse>('space_review', { req }),
  archiveSpace: (space: string) => call<null>('archive_space', { space }),
  shipSpace: (req: ShipSpaceRequest) => call<Space>('ship_space', { req }),
  undoSpaceTurn: (space: string) => call<Space>('undo_space_turn', { space }),
  unarchiveSpace: (space: string) => call<Space>('unarchive_space', { space }),
  spaceSendFeedback: (req: SpaceFeedbackRequest) =>
    call<string>('space_send_feedback', { req }),
  /** What a space runs, where each command comes from, and trust. */
  spaceConfig: (space: string) =>
    call<SpaceConfigView>('space_config', { space }),
  /** "Run commands from this repo?": Allow (per project) / Not now. */
  spaceTrust: (req: SpaceTrustRequest) => call<Space>('space_trust', { req }),
  /** Retry a failed setup, or continue without it. */
  spaceSetup: (req: SpaceSetupRequest) => call<Space>('space_setup', { req }),
  /** Starts or stops the space's `run` command. */
  spaceRun: (req: SpaceRunRequest) => call<Space>('space_run', { req }),
  spaceLogs: (space: string) => call<SpaceLogLine[]>('space_logs', { space }),
  /** A project's merged config, read-only (Settings → Labs). */
  projectConfig: (project: string) =>
    call<EffectiveConfig>('project_config', { project }),
  globalConfig: () => call<GlobalConfigInfo>('global_config'),
  /** Creates the global config from a template when missing, then opens
   *  it in the default editor. */
  openGlobalConfig: () => call<GlobalConfigInfo>('open_global_config'),
  /** Theodore account (Settings → Account, Onboarding). The sign-in
   *  dialog shows its own failures, so starting and polling don't toast. */
  accountStatus: () => call<AccountStatus>('account_status'),
  accountSignInStart: (req: AccountSignInRequest) =>
    call<AccountSignInStart>('account_sign_in_start', { req }, true),
  accountSignInPoll: () =>
    call<AccountSignInState>('account_sign_in_poll', undefined, true),
  accountSignInCancel: () => call<null>('account_sign_in_cancel'),
  accountSignOut: () => call<AccountStatus>('account_sign_out'),
  /** Brings the window forward after the browser hands the sign-in back.
   *  Cosmetic: a failure is ignored, never toasted. */
  focusWindow: (): Promise<null> =>
    getTransport()
      .invoke<null>('focus_window')
      .catch(() => null),
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
