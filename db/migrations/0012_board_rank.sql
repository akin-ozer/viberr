-- Board position within a stage: a sparse rank for drag-to-reorder cards.
-- NULL falls back to the task-key number (the pre-reorder default order), so
-- existing tasks keep their current board order until a card is reordered.
ALTER TABLE task_projections ADD COLUMN board_rank REAL;
