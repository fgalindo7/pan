export interface GitBranchStatusProps {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
}

export class GitBranchStatus {
  readonly name: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;

  constructor(props: GitBranchStatusProps) {
    this.name = props.name;
    this.upstream = props.upstream;
    this.ahead = props.ahead ?? 0;
    this.behind = props.behind ?? 0;
    this.detached = Boolean(props.detached);
  }

  isAhead() {
    return this.ahead > 0;
  }

  isBehind() {
    return this.behind > 0;
  }

  isDetached() {
    return this.detached;
  }
}
