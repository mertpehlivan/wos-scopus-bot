package com.academic.broker.service.yearly;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Guards the Spring wiring of the sanitizer bean — it has a second
 * (package-private, test) constructor, and without an explicit @Autowired
 * Spring fails the whole broker at startup ("No default constructor found").
 */
class YearlyStatsSanitizerServiceWiringTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(YearlyStatsSanitizerService.class);

    @Test
    void beanCreatesWithDefaultMode() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(YearlyStatsSanitizerService.class).getMode())
                    .isEqualTo(YearlyStatsSanitizerService.Mode.SHADOW);
        });
    }

    @Test
    void beanHonoursConfiguredMode() {
        runner.withPropertyValues("broker.yearly-sanitize-mode=on").run(ctx ->
                assertThat(ctx.getBean(YearlyStatsSanitizerService.class).getMode())
                        .isEqualTo(YearlyStatsSanitizerService.Mode.ON));
    }
}
