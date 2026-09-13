export interface TransactionStatement {
  sql: string;
  params?: any[];
  /** Number of RETURNING/SELECT rows required; a mismatch rolls back the transaction. */
  expectedRows?: number;
}
export function runTransactionStatements(
  tx: { query(sql: string, params?: any[]): Promise<{ rows: unknown[] }> },
  statements: TransactionStatement[]
): Promise<void>;
