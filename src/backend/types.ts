import type { HouseData } from '../types';

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY' | 'USER_UPDATED' | 'INITIAL' | 'TOKEN_REFRESHED' | string;
export type DataTable = Exclude<keyof HouseData, 'household' | 'members'>;
export type RealtimeStatus = 'connecting' | 'live' | 'offline';

export class ConflictError extends Error {
  constructor() {
    super('Cet élément a été modifié entre-temps par l’autre personne. Les données ont été rechargées : vérifiez puis réessayez.');
  }
}

export interface Backend {
  mode: 'supabase' | 'demo';
  getUser(): Promise<AuthUser | null>;
  onAuthChange(cb: (user: AuthUser | null, event: AuthEvent) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<{ needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;

  myHouseholdId(): Promise<string | null>;
  loadAll(householdId: string): Promise<HouseData>;
  loadTable(householdId: string, table: DataTable | 'households' | 'household_members'): Promise<unknown[]>;
  insert<T>(table: string, rows: Partial<T>[] | Partial<T>): Promise<T[]>;
  /** Mise à jour par identifiant ; si `version` est fourni, échoue avec ConflictError en cas de modification concurrente. */
  update<T>(table: string, id: string, patch: Partial<T>, version?: number): Promise<T>;
  remove(table: string, id: string): Promise<void>;
  rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(householdId: string, userId: string, onChange: (table: string) => void, onStatus: (s: RealtimeStatus) => void): () => void;
}
