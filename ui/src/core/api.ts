/** Typed wrappers for every command in `.context/commands.md`, over `Transport`. */
import { getTransport } from './transport';
import type {
  AgentStatus,
  AppInfo,
  AskRequest,
  Bootstrap,
  BootstrapScope,
  CommandError,
  FileRequest,
  OpenPrRequest,
  OpenPrResponse,
  PrId,
  Revision,
  RevisionRequest,
  RunSkillRequest,
  SubmitReviewRequest,
  SyncFrame,
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
};
