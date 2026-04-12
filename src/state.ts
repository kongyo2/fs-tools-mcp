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
