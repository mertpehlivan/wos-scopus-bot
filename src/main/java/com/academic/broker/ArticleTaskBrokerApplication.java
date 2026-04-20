package com.academic.broker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class ArticleTaskBrokerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ArticleTaskBrokerApplication.class, args);
    }
}
