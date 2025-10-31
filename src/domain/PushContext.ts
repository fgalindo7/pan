export interface CommitMessageContext {
  branch: string;
  author?: string;
  changedFiles?: string[];
  statusText?: string;
  diffStat?: string;
  commandSummary?: string[];
  additionalNotes?: string;
}

export interface PushContextProps extends CommitMessageContext {}

export class PushContext {
  private readonly props: PushContextProps;

  constructor(props: PushContextProps) {
    this.props = {
      ...props,
      changedFiles: props.changedFiles ? [...props.changedFiles] : undefined,
      commandSummary: props.commandSummary ? [...props.commandSummary] : undefined,
    };
  }

  get branch() {
    return this.props.branch;
  }

  withAdditionalNotes(note: string) {
    const notes = this.props.additionalNotes ? `${this.props.additionalNotes}\n${note}` : note;
    return new PushContext({ ...this.props, additionalNotes: notes });
  }

  toCommitMessageContext(): CommitMessageContext {
    return {
      branch: this.props.branch,
      author: this.props.author,
      changedFiles: this.props.changedFiles ? [...this.props.changedFiles] : undefined,
      statusText: this.props.statusText,
      diffStat: this.props.diffStat,
      commandSummary: this.props.commandSummary ? [...this.props.commandSummary] : undefined,
      additionalNotes: this.props.additionalNotes,
    };
  }
}
