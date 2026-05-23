# Orchestration and Boot Refactor

## Goal
Replace ad-hoc boot logic with a robust, type-safe orchestration layer that ensures clean dependency injection, lifecycle management, and reliable testing for the bot's core loop.

## Proposed Architecture
1. **Lifecycle Manager**: Define a `Lifecycle` interface with `start()`, `prepare()`, and `stop()` methods for all services (Hyperindex, Execution, Mempool, etc.).
2. **Context Provider**: Refactor `RuntimeContext` into a `BotSystem` class that manages the dependencies and lifecycle of all services.
3. **Loop Controller**: Refactor `runPassLoop` into a `PassRunner` class to allow fine-grained control, pausing, and injection for testing.
4. **Standardized Test Harness**: Introduce a `BotTestHarness` that mocks components with a standardized API to allow high-fidelity integration testing.

## Why this approach?
- **Precise Dependency Management**: Avoids global state and ad-hoc initialization.
- **Reliable Lifecycle**: Ensures services (Hyperindex, RPCs) shut down in correct order.
- **Testability**: Allows injecting mocked `ExecutionService` or `MempoolService` directly into the `PassRunner`.

**What do you think of this approach to formalize the lifecycle and dependency management for the bot?**
