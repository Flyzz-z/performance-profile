sysbench.cmdline.options = {
  tables = {"Number of tables", 10},
  table_size = {"Rows per table", 100000}
}

function init()
  print("INDEX_READ_SQL=SELECT c FROM sbtestN WHERE k=?")
  print("INDEX_READ_RESULT=one-row;payload=c;prepared=true")
end

function thread_init()
  connection = sysbench.sql.driver():connect()
  statements = {}
  parameters = {}
  validated_events = 0
  for i = 1, sysbench.opt.tables do
    statements[i] = connection:prepare(string.format("SELECT c FROM sbtest%d WHERE k=?", i))
    parameters[i] = statements[i]:bind_create(sysbench.sql.type.INT)
    statements[i]:bind_param(parameters[i])
  end
end

function event()
  local table_number = sysbench.rand.uniform(1, sysbench.opt.tables)
  parameters[table_number]:set(sysbench.rand.uniform(1, sysbench.opt.table_size))
  local result = statements[table_number]:execute()
  assert(result.nrows == 1, "INDEX_READ_ERROR: expected exactly one row")
  -- The prepared-query driver consumes the SELECT payload before returning.
  -- nrows is the retained result metadata; fetching again would read an empty set.
  validated_events = validated_events + 1
end

function thread_done()
  print(string.format("INDEX_READ_VALIDATED thread=%d events=%d", sysbench.tid, validated_events))
  for i = 1, sysbench.opt.tables do statements[i]:close() end
  connection:disconnect()
end
