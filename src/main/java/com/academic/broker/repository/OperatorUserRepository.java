package com.academic.broker.repository;

import com.academic.broker.domain.OperatorUser;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface OperatorUserRepository extends JpaRepository<OperatorUser, UUID> {
    Optional<OperatorUser> findByUsername(String username);
    boolean existsByUsername(String username);
}
