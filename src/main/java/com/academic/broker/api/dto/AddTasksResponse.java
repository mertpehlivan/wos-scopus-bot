package com.academic.broker.api.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AddTasksResponse {

    private int added;
    private int skipped; // already present as PENDING/PROCESSING
    private List<String> addedIds;
    /** Database ids of newly created tasks. Lets the backend audit / cancel by id. */
    @lombok.Builder.Default
    private List<Long> addedTaskIds = new java.util.ArrayList<>();
}
