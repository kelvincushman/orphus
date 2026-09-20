# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] - 2026-09-20

### Added

- **The System One decision layer.** Fixed questions in, typed decisions with probabilities out, and an abstain band that defers to the model whenever confidence falls below a per-surface threshold. Three primitives — `noul` (yes/no), `choice` (pick one, up to 255 labels), and `score` (rate against an ordered rubric, up to 11 levels) — in the same wire shape TypeSafe's Jev uses, so a question written here stays portable and the two can answer identical state for comparison. Nothing is generated: every answer is a distribution over the answers the caller supplied, so a malformed answer is not a possible outcome, only an uncertain one.
- **The `null` adapter, and it is the default.** Every answer is maximally uncertain, so every decision abstains and every call site behaves exactly as it did before this package existed. It is how the wiring is proven: a test that changes behaviour under `null` has found a wiring bug, not a model.
- **Receipts for every decision, including the abstentions.** Each records the answer, its probability and confidence, the threshold applied, the adapter that produced it, a hash of the state, and a hash of the question's exact wording — so an outcome can later be credited to the criteria version that produced it rather than to a question whose wording has since been revised.
