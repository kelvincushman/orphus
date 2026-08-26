import { Type } from "typebox";

export const goalExecutionCheckSchema = Type.Object(
  {
    command: Type.String(),
    expect: Type.String(),
  },
  { additionalProperties: false },
);

export const goalExecutionCheckResultSchema = Type.Object(
  {
    command: Type.String(),
    expect: Type.String(),
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked")]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

export const goalExecutionLeafSchema = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    task: Type.String(),
    owns: Type.Array(Type.String()),
    needs: Type.Array(Type.String()),
    tier: Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("judgment")]),
    checks: Type.Array(goalExecutionCheckSchema),
  },
  { additionalProperties: false },
);

export const goalExecutionPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    leaves: Type.Array(goalExecutionLeafSchema),
  },
  { additionalProperties: false },
);

export const goalExecutionLeafVerificationSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("verified"), Type.Literal("failed"), Type.Literal("blocked")]),
    evidence: Type.String(),
    remaining_work: Type.String(),
    checks: Type.Array(goalExecutionCheckResultSchema),
  },
  { additionalProperties: false },
);

const reviewFindingSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    objective_alignment: Type.Union([
      Type.Literal("required_by_objective"),
      Type.Literal("consistent_with_objective"),
      Type.Literal("beyond_objective"),
      Type.Literal("contradicts_objective"),
    ]),
    priority: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()])),
    code_location: Type.Object(
      {
        absolute_file_path: Type.String(),
        line_range: Type.Object(
          {
            start: Type.Integer({ minimum: 1 }),
            end: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const requirementsTraceabilitySchema = Type.Object(
  {
    requirement: Type.String(),
    status: Type.Union([
      Type.Literal("proven"),
      Type.Literal("contradicted"),
      Type.Literal("missing"),
      Type.Literal("unverified"),
    ]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

const reviewerErrorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("validation_unavailable"),
      Type.Literal("dependency_unavailable"),
      Type.Literal("tool_failure"),
      Type.Literal("reviewer_failure"),
    ]),
    message: Type.String(),
    attempted_recovery: Type.String(),
  },
  { additionalProperties: false },
);

export const reviewDecisionSchema = Type.Object(
  {
    findings: Type.Array(reviewFindingSchema),
    overall_correctness: Type.Union([Type.Literal("patch is correct"), Type.Literal("patch is incorrect")]),
    overall_explanation: Type.String(),
    overall_confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    goal_oracle_satisfied: Type.Boolean(),
    requirements_traceability: Type.Array(requirementsTraceabilitySchema),
    receipt_assessment: Type.String(),
    verification_remaining: Type.String(),
    stop_review_loop: Type.Boolean(),
    reviewer_error: Type.Optional(Type.Union([Type.Null(), reviewerErrorSchema])),
  },
  { additionalProperties: false },
);
