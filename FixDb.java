import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;

public class FixDb {
    public static void main(String[] args) {
        String url = "jdbc:postgresql://localhost:5433/article_broker";
        String user = "postgres";
        String password = "postgres";

        try (Connection conn = DriverManager.getConnection(url, user, password);
                Statement stmt = conn.createStatement()) {

            System.out.println("Connected to the database");

            // Try to drop the check constraint. Note: the exact constraint name depends on
            // Hibernate generation.
            // A common generated name is article_tasks_target_source_check
            try {
                stmt.execute("ALTER TABLE article_tasks DROP CONSTRAINT IF EXISTS article_tasks_target_source_check");
                System.out.println("Dropped article_tasks_target_source_check");
            } catch (Exception e) {
                System.out
                        .println("Constraint article_tasks_target_source_check not found or error: " + e.getMessage());
            }

            try {
                stmt.execute("ALTER TABLE article_tasks DROP CONSTRAINT IF EXISTS chk_article_tasks_target_source");
                System.out.println("Dropped chk_article_tasks_target_source");
            } catch (Exception e) {
                System.out.println("Constraint chk_article_tasks_target_source not found or error: " + e.getMessage());
            }

            // Also for task_type
            try {
                stmt.execute("ALTER TABLE article_tasks DROP CONSTRAINT IF EXISTS article_tasks_task_type_check");
                System.out.println("Dropped article_tasks_task_type_check");
            } catch (Exception e) {
                System.out.println("Constraint article_tasks_task_type_check not found or error: " + e.getMessage());
            }

            // If the table is ephemeral, we could just drop it, but there might be PENDING
            // tasks we shouldn't lose,
            // so modifying the constraint is better.

            System.out.println("Finished DB fix");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
