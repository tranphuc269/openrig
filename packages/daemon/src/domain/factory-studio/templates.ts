// Factory Studio — built-in deliverable templates.
//
// A deliverable is a document one team member must produce. These templates
// pre-fill the title, the output path and the outline the member is told to
// follow. The UI offers them as starting points; every field stays editable.

export interface DeliverableTemplate {
  id: string;
  title: string;
  /** Default output path, relative to the team's working directory. */
  path: string;
  /** Default role id the template fits best (used only as a UI hint). */
  suggestedRole: string;
  outline: string;
  acceptance: string;
}

export const DELIVERABLE_TEMPLATES: DeliverableTemplate[] = [
  {
    id: "prd",
    title: "Product Requirements Document",
    path: "docs/requirements/prd.md",
    suggestedRole: "product-analyst",
    outline: [
      "# Product Requirements",
      "## 1. Background and goals",
      "## 2. Users and personas",
      "## 3. User stories (As a … I want … so that …)",
      "## 4. Functional requirements (numbered, testable)",
      "## 5. Non-functional requirements (performance, security, availability)",
      "## 6. Out of scope",
      "## 7. Open questions",
    ].join("\n"),
    acceptance: "Every functional requirement is numbered and testable; open questions are listed, not guessed.",
  },
  {
    id: "system-design",
    title: "System Design Document",
    path: "docs/design/system-design.md",
    suggestedRole: "architect",
    outline: [
      "# System Design",
      "## 1. Context and scope",
      "## 2. Architecture overview (diagram in Mermaid)",
      "## 3. Components and responsibilities",
      "## 4. Data model",
      "## 5. Key flows (sequence diagrams)",
      "## 6. Technology choices and trade-offs",
      "## 7. Security, scalability, observability",
      "## 8. Risks and open decisions",
    ].join("\n"),
    acceptance: "Covers every requirement in the PRD; includes at least one architecture diagram and one sequence diagram.",
  },
  {
    id: "api-spec",
    title: "API Documentation",
    path: "docs/api/api-spec.md",
    suggestedRole: "backend",
    outline: [
      "# API Documentation",
      "## Conventions (base URL, auth, errors, pagination, versioning)",
      "## Endpoints",
      "For each endpoint: method + path, purpose, request (params, body schema, example),",
      "responses (status codes, body schema, example), errors.",
      "## Data schemas",
      "## Changelog",
    ].join("\n"),
    acceptance: "Every endpoint has request and response examples and its error cases; schemas match the system design data model.",
  },
  {
    id: "test-plan",
    title: "Test Plan",
    path: "docs/testing/test-plan.md",
    suggestedRole: "qa",
    outline: [
      "# Test Plan",
      "## 1. Scope and objectives",
      "## 2. Test strategy (unit, integration, e2e, performance, security)",
      "## 3. Test environment and data",
      "## 4. Test cases (ID, requirement, steps, expected result, priority)",
      "## 5. Entry / exit criteria",
      "## 6. Risks",
      "## 7. Traceability matrix (requirement → test case IDs)",
    ].join("\n"),
    acceptance: "Every PRD requirement maps to at least one test case in the traceability matrix.",
  },
  {
    id: "db-design",
    title: "Database Design",
    path: "docs/design/database.md",
    suggestedRole: "backend",
    outline: [
      "# Database Design",
      "## ER diagram (Mermaid)",
      "## Tables (columns, types, constraints, indexes)",
      "## Relationships",
      "## Migration plan",
    ].join("\n"),
    acceptance: "Every entity in the system design appears with keys and indexes.",
  },
  {
    id: "deployment-guide",
    title: "Deployment Guide",
    path: "docs/ops/deployment.md",
    suggestedRole: "devops",
    outline: [
      "# Deployment Guide",
      "## Environments",
      "## Prerequisites",
      "## Build and release steps",
      "## Configuration and secrets (names only, never values)",
      "## Rollback",
      "## Monitoring and alerts",
    ].join("\n"),
    acceptance: "A new engineer can deploy and roll back by following the steps alone.",
  },
];
