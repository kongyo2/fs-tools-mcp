export type ReadFileStateEntry = {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
};

export type SessionState = {
  readFileState: Map<string, ReadFileStateEntry>;
};

export function createSessionState(): SessionState {
  return {
    readFileState: new Map<string, ReadFileStateEntry>(),
  };
}

export function recordReadState(
  state: SessionState,
  fullPath: string,
  entry: ReadFileStateEntry,
): void {
  state.readFileState.set(fullPath, entry);
}

export function getReadState(
  state: SessionState,
  fullPath: string,
): ReadFileStateEntry | undefined {
  return state.readFileState.get(fullPath);
}
