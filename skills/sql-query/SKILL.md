---
name: sql-query
description: Run safe read-only SQL queries against SQLite/PostgreSQL/MySQL databases, blocking mutating statements by default.
---

# SQL Query

Use `scripts/query_database.py <database-url> <sql>` to execute read-only SQL. Mutating statements are blocked unless the script is explicitly extended by an operator.

Examples:

```bash
python skills/sql-query/scripts/query_database.py sqlite:///data.db "SELECT * FROM items LIMIT 20"
```
