/** Typed wrappers for every command in `.context/commands.md`, over `Transport`. */
import { getTransport } from './transport';
import type {
  AgentStatus,
  AppInfo,
  AskRequest,
  Bootstrap,
  BootstrapScope,
  CommandError,
  DelegateRequest,
  FileRequest,
  HostAuthStatus,
  OpenPrRequest,
  OpenPrResponse,
  Person,
  PrId,
  ReplyRequest,
  Revision,
  RevisionRequest,
  ResolveRequest,
  RunSkillRequest,
  SetTokenRequest,
  SkillInfo,
  SubmitReviewRequest,
  SyncFrame,
  TaskDecision,
  Transaction,
  TransactionResult,
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

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await getTransport().invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
      throw new CommandFailure(e as CommandError);
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
  setHostToken: (req: SetTokenRequest) =>
    call<HostAuthStatus>('set_host_token', { req }),
  replyThread: (req: ReplyRequest) => call<null>('reply_thread', { req }),
  resolveThread: (req: ResolveRequest) => call<null>('resolve_thread', { req }),
  listSkills: (pr: PrId | null) => call<SkillInfo[]>('list_skills', { pr }),
  delegateTask: (req: DelegateRequest) =>
    call<string>('delegate_task', { req }),
  decideTask: (req: TaskDecision) => call<null>('decide_task', { req }),
};
