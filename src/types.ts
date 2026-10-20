export type UUID = string;
export type ISODate = string; // AAAA-MM-JJ

export type Effort = 'light' | 'moderate' | 'heavy';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'once';
export type OccStatus = 'todo' | 'in_progress' | 'done' | 'postponed' | 'cancelled';
export type SplitMode = 'equal' | 'percent' | 'fixed' | 'single';

export interface NotifPrefs {
  enabled?: boolean;
  browser?: boolean;
  categories?: Partial<Record<NotifType, boolean>>;
  quiet_start?: string; // "22:00"
  quiet_end?: string; // "08:00"
  reminder_hour?: string; // "08:00" rappel local des tâches du jour
}

export interface UiPrefs {
  theme?: 'system' | 'light' | 'dark';
  calendar_view?: 'month' | 'week' | 'day' | 'upcoming';
  calendar_show_expenses?: boolean;
}

export type NotifType =
  | 'task_due' | 'task_overdue' | 'task_assigned' | 'swap' | 'reimbursement'
  | 'expense' | 'shopping' | 'stock' | 'maintenance' | 'member';

export interface Profile {
  id: UUID;
  display_name: string;
  notif_prefs: NotifPrefs;
  ui_prefs: UiPrefs;
  deleted: boolean;
  version: number;
}

export interface HouseholdSettings {
  effort_coef?: Record<Effort, number>;
  default_split?: SplitMode;
  enable_in_progress?: boolean;
  avoid_repeats?: boolean;
  window_weeks?: number;
  /** regrouper les tâches d'une même pièce le même jour (par défaut : oui) */
  group_by_zone?: boolean;
  /** groupes de tâches nommés et leur couleur (la clé est le nom exact) */
  groups?: Record<string, { color: string }>;
}

export interface Household {
  id: UUID;
  name: string;
  currency: string;
  start_date: ISODate;
  invite_code: string | null;
  settings: HouseholdSettings;
  created_by: UUID | null;
  version: number;
}

export interface Member {
  household_id: UUID;
  user_id: UUID;
  role: 'owner' | 'member';
  joined_at: string;
}

export interface Zone {
  id: UUID;
  household_id: UUID;
  name: string;
  icon: string;
  active: boolean;
  position: number;
  version: number;
}

export interface Category {
  id: UUID;
  household_id: UUID;
  kind: 'expense' | 'shopping';
  name: string;
  position: number;
  archived: boolean;
  version: number;
}

export interface TaskTemplate {
  id: UUID;
  household_id: UUID;
  zone_id: UUID | null;
  name: string;
  description: string;
  instructions: string;
  frequency: Frequency;
  weekdays: number[]; // 1 = lundi … 7 = dimanche
  /** mensuelle : semaine du mois (1 à 4, -1 = dernière) ; le jour vient de weekdays[0] */
  month_week: number | null;
  /** groupe nommé : tâches faites le même jour par la même personne (ex. « Sols ») */
  group_name: string | null;
  once_date: ISODate | null;
  window_days: number;
  duration_min: number;
  effort: Effort;
  preferred_user: UUID | null;
  fixed_user: UUID | null;
  start_date: ISODate;
  end_date: ISODate | null;
  active: boolean;
  archived: boolean;
  created_by: UUID | null;
  created_at: string;
  version: number;
}

export interface Occurrence {
  id: UUID;
  household_id: UUID;
  template_id: UUID;
  scheduled_date: ISODate;
  due_date: ISODate;
  assigned_to: UUID | null;
  status: OccStatus;
  proposed: boolean;
  locked: boolean;
  name: string;
  zone_id: UUID | null;
  estimated_min: number;
  effort: Effort;
  weight: number;
  done_at: string | null;
  done_by: UUID | null;
  actual_min: number | null;
  problem: string | null;
  created_at: string;
  version: number;
}

export interface Unavailability {
  id: UUID;
  household_id: UUID;
  user_id: UUID;
  start_date: ISODate;
  end_date: ISODate;
  note: string;
}

export interface SwapRequest {
  id: UUID;
  household_id: UUID;
  occurrence_id: UUID;
  from_user: UUID;
  to_user: UUID;
  message: string;
  status: 'pending' | 'accepted' | 'refused' | 'cancelled';
  created_at: string;
  responded_at: string | null;
  version: number;
}

export interface Comment {
  id: UUID;
  household_id: UUID;
  entity: 'occurrence' | 'maintenance' | 'expense';
  entity_id: UUID;
  user_id: UUID;
  body: string;
  created_at: string;
}

export interface Expense {
  id: UUID;
  household_id: UUID;
  client_key: UUID;
  title: string;
  amount_cents: number;
  date: ISODate;
  category_id: UUID | null;
  paid_by: UUID;
  split_mode: SplitMode;
  status: 'draft' | 'validated' | 'cancelled';
  note: string;
  maintenance_id: UUID | null;
  recurring_id: UUID | null;
  created_by: UUID | null;
  created_at: string;
  version: number;
}

/** Saisie de partage conservée pour regénérer les parts chaque mois. */
export interface SplitInput {
  user_id: UUID;
  value?: number;
  included?: boolean;
}

export interface RecurringExpense {
  id: UUID;
  household_id: UUID;
  title: string;
  amount_cents: number;
  category_id: UUID | null;
  paid_by: UUID;
  split_mode: SplitMode;
  split_inputs: SplitInput[];
  day_of_month: number; // 1–31 (ramené au dernier jour si le mois est plus court)
  start_date: ISODate;
  end_date: ISODate | null;
  last_generated: ISODate | null;
  auto_validate: boolean;
  active: boolean;
  note: string;
  created_by: UUID | null;
  created_at: string;
  version: number;
}

/** Tâche privée « Ma chambre » : visible uniquement par son autrice, hors répartition. */
export interface PrivateTask {
  id: UUID;
  household_id: UUID;
  user_id: UUID;
  title: string;
  note: string;
  due_date: ISODate | null;
  repeat: 'none' | 'weekly' | 'monthly';
  done: boolean;
  done_at: string | null;
  created_at: string;
  version: number;
}

export interface ExpenseShare {
  expense_id: UUID;
  household_id: UUID;
  user_id: UUID;
  share_cents: number;
  percent: number | null;
}

export interface Reimbursement {
  id: UUID;
  household_id: UUID;
  client_key: UUID;
  from_user: UUID;
  to_user: UUID;
  amount_cents: number;
  date: ISODate;
  note: string;
  status: 'planned' | 'done' | 'cancelled';
  created_by: UUID | null;
  created_at: string;
  version: number;
}

export interface Budget {
  id: UUID;
  household_id: UUID;
  period: 'month' | 'year';
  year: number;
  month: number;
  total_cents: number;
  category_limits: Record<UUID, number>;
  version: number;
}

export interface ShoppingItem {
  id: UUID;
  household_id: UUID;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  priority: 'low' | 'normal' | 'high';
  assigned_to: UUID | null;
  status: 'to_buy' | 'bought' | 'deleted';
  note: string;
  price_estimate_cents: number | null;
  stock_id: UUID | null;
  bought_at: string | null;
  bought_by: UUID | null;
  created_by: UUID | null;
  created_at: string;
  version: number;
}

export interface Stock {
  id: UUID;
  household_id: UUID;
  name: string;
  quantity: number;
  unit: string;
  min_threshold: number;
  location: string;
  updated_at: string;
  version: number;
}

export interface Maintenance {
  id: UUID;
  household_id: UUID;
  title: string;
  description: string;
  category: string;
  reported_at: ISODate;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  owner: UUID | null;
  due_date: ISODate | null;
  status: 'todo' | 'in_progress' | 'resolved' | 'abandoned';
  created_by: UUID | null;
  created_at: string;
  version: number;
}

export interface Notification {
  id: UUID;
  household_id: UUID;
  user_id: UUID;
  type: NotifType | string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
}

export interface ActivityLog {
  id: number;
  household_id: UUID;
  user_id: UUID | null;
  entity: string;
  entity_id: UUID | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

/** Toutes les données d'une colocation, chargées en mémoire (volume modeste pour deux personnes). */
export interface HouseData {
  household: Household;
  members: Member[];
  profiles: Profile[];
  zones: Zone[];
  categories: Category[];
  task_templates: TaskTemplate[];
  task_occurrences: Occurrence[];
  unavailabilities: Unavailability[];
  swap_requests: SwapRequest[];
  comments: Comment[];
  expenses: Expense[];
  expense_shares: ExpenseShare[];
  recurring_expenses: RecurringExpense[];
  private_tasks: PrivateTask[];
  reimbursements: Reimbursement[];
  budgets: Budget[];
  shopping_items: ShoppingItem[];
  stocks: Stock[];
  maintenance: Maintenance[];
  notifications: Notification[];
  activity_log: ActivityLog[];
}

export type TableName = Exclude<keyof HouseData, 'household' | 'members' | 'profiles'> | 'households' | 'profiles' | 'household_members';
