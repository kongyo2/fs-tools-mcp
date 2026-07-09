export type ReadFileStateEntry = {
  timestamp: number;
  offset?: number;
  limit?: number;
};

export type SessionState = {
  readFileState: Map<string, ReadFileStateEntry>;
};

export function createSessionState(): SessionState {
  return {
    readFileState: new Map<string, ReadFileStateEntry>(),
  };
}
