declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: any): Database;
    exec(sql: string, params?: any): QueryExecResult[];
    each(sql: string, callback: (row: any) => void, done?: () => void): void;
    prepare(sql: string): Statement;
    close(): void;
    getRowsModified(): number;
  }

  interface Statement {
    bind(params?: any): boolean;
    step(): boolean;
    getAsObject(params?: any): any;
    get(params?: any): any[];
    run(params?: any): void;
    free(): boolean;
    getColumnNames(): string[];
  }

  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export type InitSqlJsStatic = (config?: any) => Promise<SqlJsStatic>;
  const initSqlJs: InitSqlJsStatic;
  export default initSqlJs;
  export type { Database, Statement, QueryExecResult, SqlJsStatic };
}
