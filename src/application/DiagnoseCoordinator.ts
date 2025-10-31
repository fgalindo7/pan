import { PushContext } from '../domain/PushContext';
import { ShellCommandExecutor } from '../infrastructure/ShellCommandExecutor';
import { LoggingService } from '../infrastructure/LoggingService';

export class DiagnoseCoordinator {
  constructor(
    private readonly shell: ShellCommandExecutor,
    private readonly logger: LoggingService
  ) {}

  async orchestrateDiagnose(context: PushContext): Promise<void> {
    this.logger.info('Starting diagnosis');
    // Example: run git status
    const result = await this.shell.run('git status');
    this.logger.info(`Diagnosis result: ${result}`);
  }
}
