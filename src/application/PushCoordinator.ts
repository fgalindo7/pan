import { PushContext } from '../domain/PushContext';
import { PushPolicy } from '../domain/PushPolicy';
import { ShellCommandExecutor } from '../infrastructure/ShellCommandExecutor';
import { LoggingService } from '../infrastructure/LoggingService';

export class PushCoordinator {
  constructor(
    private readonly shell: ShellCommandExecutor,
    private readonly logger: LoggingService,
    private readonly policy: PushPolicy
  ) {}

  async orchestratePush(context: PushContext): Promise<void> {
    this.logger.info('Starting push orchestration');
    // Validate policy (example: check commit prefix)
    // Assume prefix is the part before first '/' in branch name
    const branch = (context as any).branch || '';
    const prefix = branch.split('/')[0];
    if (!this.policy.isAllowedPrefix(prefix)) {
      this.logger.error(`Push not allowed by policy: invalid prefix '${prefix}'`);
      throw new Error('Push not allowed');
    }
    // Execute push
    await this.shell.run('git push');
    this.logger.info('Push completed');
  }
}
