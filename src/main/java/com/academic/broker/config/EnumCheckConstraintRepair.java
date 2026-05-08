package com.academic.broker.config;

import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.domain.TaskType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Hibernate ORM 6.x emits a CHECK constraint for every {@code @Enumerated(EnumType.STRING)}
 * column when DDL is first generated. With {@code ddl-auto: update}, that
 * constraint is <b>not</b> rewritten when a new enum value is added in code —
 * the column happily lengthens (varchar(20) is wide enough) but inserts of the
 * new literal blow up server-side as <i>"violates check constraint"</i>, which
 * the global handler maps to a generic HTTP 500 (<i>"An unexpected error
 * occurred"</i>) — exactly the symptom we saw the day OPENALEX shipped.
 *
 * <p>This runner is the cheapest fix that doesn't require Flyway: at startup it
 * drops any auto-generated check constraints on the enum columns we care about
 * and re-adds them with the current set of enum literals. Idempotent — it's
 * safe to run on every boot, and it's a no-op when the constraints are absent
 * (e.g. on a brand-new database where DDL just generated them with the right
 * values).
 *
 * <p>Scope: only the columns we actually evolve. If a future enum gets a new
 * value, add it here.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EnumCheckConstraintRepair {

    private final JdbcTemplate jdbc;

    @EventListener(ApplicationReadyEvent.class)
    public void repair() {
        // article_tasks.target_source -> TargetSource (added OPENALEX in v1.6)
        repairColumn("article_tasks", "target_source",
                Arrays.stream(TargetSource.values()).map(Enum::name).collect(Collectors.toList()));

        // article_tasks.task_type -> TaskType
        repairColumn("article_tasks", "task_type",
                Arrays.stream(TaskType.values()).map(Enum::name).collect(Collectors.toList()));

        // article_tasks.status -> TaskStatus
        repairColumn("article_tasks", "status",
                Arrays.stream(TaskStatus.values()).map(Enum::name).collect(Collectors.toList()));
    }

    /**
     * Best-effort repair of the CHECK constraint on {@code table.column}.
     *
     * <p>Hibernate names auto-generated check constraints with PostgreSQL's
     * default scheme: {@code <table>_<column>_check}. We use information_schema
     * to find the actual constraint name (Hibernate is picky and may pick a
     * different name on different versions), drop whatever's there, and add a
     * fresh one with the current enum set.
     */
    private void repairColumn(String table, String column, List<String> allowedValues) {
        try {
            // 1) Find every check constraint on this column
            List<String> constraintNames = jdbc.query(
                    "SELECT con.conname " +
                    "FROM pg_constraint con " +
                    "JOIN pg_class cls ON cls.oid = con.conrelid " +
                    "JOIN pg_namespace ns ON ns.oid = cls.relnamespace " +
                    "JOIN pg_attribute att ON att.attrelid = cls.oid AND att.attnum = ANY(con.conkey) " +
                    "WHERE cls.relname = ? AND att.attname = ? AND con.contype = 'c' " +
                    "  AND ns.nspname = current_schema()",
                    (rs, n) -> rs.getString(1),
                    table, column);

            for (String name : constraintNames) {
                try {
                    jdbc.execute("ALTER TABLE " + table + " DROP CONSTRAINT IF EXISTS \"" + name + "\"");
                    log.info("[EnumRepair] Dropped check constraint {} on {}.{}", name, table, column);
                } catch (Exception drop) {
                    log.warn("[EnumRepair] Could not drop constraint {} on {}.{}: {}",
                            name, table, column, drop.getMessage());
                }
            }

            // 2) Re-create one constraint that includes every current enum value.
            //    Name is deterministic so subsequent restarts find & replace it
            //    cleanly via the loop above.
            String values = allowedValues.stream()
                    .map(v -> "'" + v.replace("'", "''") + "'")
                    .collect(Collectors.joining(","));
            String constraintName = table + "_" + column + "_check";
            String addSql = "ALTER TABLE " + table + " ADD CONSTRAINT \"" + constraintName +
                    "\" CHECK (" + column + " IN (" + values + "))";
            jdbc.execute(addSql);
            log.info("[EnumRepair] Re-applied check constraint {} on {}.{} with {} values",
                    constraintName, table, column, allowedValues.size());
        } catch (Exception e) {
            // Don't crash startup over this — the broker is still usable, just
            // brittle on inserts of the new enum literal. Log loudly so the
            // operator notices.
            log.warn("[EnumRepair] Repair of {}.{} failed: {}. " +
                    "Inserts of newly-added enum values may fail until this is fixed manually.",
                    table, column, e.getMessage());
        }
    }
}
