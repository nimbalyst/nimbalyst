/** Execute guarded statements inside a worker-owned database transaction. */
async function runTransactionStatements(tx, statements) {
  for (const statement of statements) {
    if (!statement || typeof statement.sql !== "string") {
      throw new Error("transaction statement sql must be a string");
    }
    const result = await tx.query(statement.sql, statement.params);
    if (
      statement.expectedRows !== undefined &&
      result.rows.length !== statement.expectedRows
    ) {
      throw new Error("Transaction conflict: guarded statement did not match");
    }
  }
}

module.exports = { runTransactionStatements };
