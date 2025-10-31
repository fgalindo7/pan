export class LoggingService {
  verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  log(message: string) {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.log(message);
    }
  }

  error(message: string) {
    // eslint-disable-next-line no-console
    console.error(message);
  }

  info(message: string) {
    // eslint-disable-next-line no-console
    console.info(message);
  }
}
