import { describe, it, expect } from "vitest";
import {
  diagnoseBlockedExecution,
  diagnosePayrollRun,
  hasExecutionBlocker,
  getDiagnosticsByCategory,
  getFirstRemediation,
  assertCanExecute,
  formatBlockedExecutionReport,
  BlockedExecutionError,
  type BlockedExecutionInput,
} from "@/lib/sdk/blockedExecutionDiagnostics";
import type { PayrollRun } from "@/types/models";

describe("SDK Blocked Execution Diagnostics (#605)", () => {
  const baseValidInput: BlockedExecutionInput = {
    runId: "run_test_001",
    totalAmount: 25000,
    employeeCount: 5,
    employeeIds: ["emp_1", "emp_2", "emp_3", "emp_4", "emp_5"],
    proofStatus: "success",
    hasProof: true,
    treasuryBalance: 100000,
    requiredReserveBuffer: 10000,
    isPaused: false,
    maxBatchSize: 20,
    maxBatchPayout: 500000,
    approvalStatus: "approved",
    isSessionExpired: false,
    isWrongNetwork: false,
    hasInvalidNonce: false,
  };

  describe("Ready / Clean Execution State", () => {
    it("reports clean execution when all preflight requirements are satisfied", () => {
      const report = diagnoseBlockedExecution(baseValidInput);

      expect(report.canExecute).toBe(true);
      expect(report.isBlocked).toBe(false);
      expect(report.blockerCount).toBe(0);
      expect(report.warningCount).toBe(0);
      expect(report.blockers).toHaveLength(0);
      expect(report.warnings).toHaveLength(0);
      expect(report.primaryBlocker).toBeUndefined();
      expect(report.summary).toMatch(/Execution clear/i);
    });

    it("does not throw when asserting ready execution", () => {
      const report = diagnoseBlockedExecution(baseValidInput);
      expect(() => assertCanExecute(report)).not.toThrow();
    });
  });

  describe("Treasury Blockers & Warnings", () => {
    it("blocks execution when treasury balance is insufficient", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 20000, // totalAmount is 25000 -> shortfall 5000
      });

      expect(report.canExecute).toBe(false);
      expect(report.isBlocked).toBe(true);
      expect(report.blockerCount).toBe(1);

      const blocker = report.blockers[0];
      expect(blocker.code).toBe("TREASURY_INSUFFICIENT_FUNDS");
      expect(blocker.category).toBe("treasury");
      expect(blocker.severity).toBe("blocker");
      expect(blocker.message).toContain("20,000");
      expect(blocker.message).toContain("25,000");
      expect(blocker.message).toContain("5,000");
      expect(blocker.remediation.action).toBe("fund_treasury");
      expect(blocker.remediation.href).toBe("/treasury");
      expect(blocker.metadata).toEqual({
        availableBalance: 20000,
        requiredAmount: 25000,
        shortfall: 5000,
      });

      expect(hasExecutionBlocker(report, "TREASURY_INSUFFICIENT_FUNDS")).toBe(true);
      expect(hasExecutionBlocker(report, "treasury")).toBe(true);
      expect(hasExecutionBlocker(report, "proof")).toBe(false);
    });

    it("emits advisory warning when treasury balance covers run but falls below safety buffer", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 30000, // totalAmount 25000 -> 5000 remaining, below 10000 buffer
        requiredReserveBuffer: 10000,
      });

      expect(report.canExecute).toBe(true);
      expect(report.isBlocked).toBe(false);
      expect(report.blockerCount).toBe(0);
      expect(report.warningCount).toBe(1);

      const warning = report.warnings[0];
      expect(warning.code).toBe("TREASURY_BELOW_RESERVE_BUFFER");
      expect(warning.severity).toBe("warning");
      expect(warning.category).toBe("treasury");
      expect(warning.remediation.action).toBe("fund_treasury");
      expect(report.summary).toMatch(/1 advisory warning/i);
    });
  });

  describe("Zero-Knowledge Proof Blockers & Freshness", () => {
    it("blocks execution when ZK proof is completely missing", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        hasProof: false,
        proofStatus: "missing",
      });

      expect(report.canExecute).toBe(false);
      expect(report.isBlocked).toBe(true);
      const proofBlocker = report.blockers.find((b) => b.category === "proof");
      expect(proofBlocker).toBeDefined();
      expect(proofBlocker?.code).toBe("PROOF_MISSING");
      expect(proofBlocker?.remediation.action).toBe("generate_proof");
    });

    it("blocks execution when proof verification has failed", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        proofStatus: "failed",
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "PROOF_VERIFICATION_FAILED")).toBe(true);
    });

    it("blocks execution when proof has expired by timestamp", () => {
      const pastTime = new Date(Date.now() - 3600000).toISOString();
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        proofExpiresAt: pastTime,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "PROOF_EXPIRED")).toBe(true);
    });

    it("emits warning when proof is attached but unverified on-chain", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        proofStatus: "pending",
      });

      expect(report.canExecute).toBe(true);
      expect(report.warningCount).toBe(1);
      expect(report.warnings[0].code).toBe("PROOF_UNVERIFIED");
    });
  });

  describe("Contract State & Pause Controls", () => {
    it("blocks execution when company or contract operations are paused for payroll", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        isPaused: true,
        pausedCategories: ["payroll", "admin"],
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "CONTRACT_PAUSED")).toBe(true);
      expect(report.blockers[0].remediation.action).toBe("resume_contract");
    });

    it("does not block execution if pause category does not affect payroll", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        isPaused: true,
        pausedCategories: ["treasury"], // does not include payroll
      });

      expect(report.isBlocked).toBe(false);
      expect(hasExecutionBlocker(report, "CONTRACT_PAUSED")).toBe(false);
    });

    it("blocks execution on network mismatch", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        isWrongNetwork: true,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "UNSUPPORTED_NETWORK")).toBe(true);
    });
  });

  describe("Batch Limits & Capacity Policy", () => {
    it("blocks execution when batch size exceeds capacity limit", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        employeeCount: 25,
        maxBatchSize: 20,
      });

      expect(report.isBlocked).toBe(true);
      const blocker = report.blockers.find((b) => b.code === "BATCH_SIZE_EXCEEDED");
      expect(blocker).toBeDefined();
      expect(blocker?.message).toMatch(/exceeding the maximum batch capacity limit of 20 by 5/);
      expect(blocker?.remediation.action).toBe("split_batch");
      expect(blocker?.metadata).toEqual({
        currentCount: 25,
        maxLimit: 20,
        excess: 5,
      });
    });

    it("blocks execution when total payout exceeds batch payout ceiling", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        totalAmount: 600000,
        maxBatchPayout: 500000,
      });

      expect(report.isBlocked).toBe(true);
      const blocker = report.blockers.find((b) => b.code === "BATCH_PAYOUT_EXCEEDED");
      expect(blocker).toBeDefined();
      expect(blocker?.remediation.action).toBe("split_batch");
      expect(blocker?.metadata?.excessAmount).toBe(100000);
    });

    it("emits warning when batch policy version is older than required", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        instructionVersion: {
          current: 1,
          required: 2,
        },
      });

      expect(report.isBlocked).toBe(false);
      expect(report.warningCount).toBe(1);
      expect(report.warnings[0].code).toBe("INSTRUCTION_VERSION_STALE");
      expect(report.warnings[0].remediation.action).toBe("refresh_policy");
    });
  });

  describe("Recipient Eligibility, Commitments & Cooldowns", () => {
    it("blocks execution when recipient list is empty", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        employeeCount: 0,
        employeeIds: [],
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "RECIPIENT_EMPTY")).toBe(true);
    });

    it("blocks execution when ineligible employees are included", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        ineligibleEmployeeIds: ["emp_inactive_1", "emp_offboarded_2"],
      });

      expect(report.isBlocked).toBe(true);
      const blocker = report.blockers.find((b) => b.code === "RECIPIENT_INELIGIBLE");
      expect(blocker).toBeDefined();
      expect(blocker?.message).toContain("2 recipient(s)");
      expect(blocker?.remediation.action).toBe("resolve_recipients");
    });

    it("blocks execution when salary commitments are missing", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        recipientsMissingCommitment: ["emp_no_commit_1"],
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "COMMITMENT_MISSING")).toBe(true);
    });

    it("blocks execution when recipients have an active wallet rotation cooldown (#521/#596)", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        recipientsWithActiveCooldown: ["emp_cooldown_1"],
      });

      expect(report.isBlocked).toBe(true);
      const blocker = report.blockers.find((b) => b.code === "RECIPIENT_COOLDOWN_ACTIVE");
      expect(blocker).toBeDefined();
      expect(blocker?.message).toMatch(/24-hour wallet rotation lock/i);
      expect(blocker?.remediation.action).toBe("resolve_recipients");
    });
  });

  describe("Approvals & Governance", () => {
    it("blocks execution when batch was rejected", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        approvalStatus: "rejected",
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "APPROVAL_REJECTED")).toBe(true);
    });

    it("blocks execution when approval has expired by status or timestamp", () => {
      const pastTime = new Date(Date.now() - 500000).toISOString();
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        approvalStatus: "approved",
        approvalExpiresAt: pastTime,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "APPROVAL_EXPIRED")).toBe(true);
    });

    it("blocks execution when approval conflict is present", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        hasApprovalConflict: true,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "APPROVAL_CONFLICT")).toBe(true);
      expect(report.blockers[0].remediation.action).toBe("review_approvals");
    });

    it("emits warning when approval status is pending", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        approvalStatus: "pending",
      });

      expect(report.isBlocked).toBe(false);
      expect(report.warningCount).toBe(1);
      expect(report.warnings[0].code).toBe("APPROVAL_REQUIRED");
    });
  });

  describe("Session & Nonce Checks", () => {
    it("blocks execution when operator session is expired", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        isSessionExpired: true,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "SESSION_EXPIRED")).toBe(true);
    });

    it("blocks execution when execution nonce is invalid or replayed", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        hasInvalidNonce: true,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "EXECUTION_NONCE_INVALID")).toBe(true);
    });

    it("emits warning on duplicate run detection", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        isDuplicate: true,
      });

      expect(report.isBlocked).toBe(false);
      expect(report.warningCount).toBe(1);
      expect(report.warnings[0].code).toBe("DUPLICATE_EXECUTION");
    });
  });

  describe("Error Throwing & Assertions", () => {
    it("throws BlockedExecutionError with diagnostic details when execution is blocked", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 5000,
        proofStatus: "missing",
      });

      expect(() => assertCanExecute(report)).toThrow(BlockedExecutionError);

      try {
        assertCanExecute(report);
      } catch (err) {
        expect(err).toBeInstanceOf(BlockedExecutionError);
        const execErr = err as BlockedExecutionError;
        expect(execErr.report.blockerCount).toBe(2);
        expect(execErr.primaryBlocker).toBeDefined();
        expect(execErr.message).toContain("Execution blocked:");
      }
    });
  });

  describe("Category Filtering & First Remediation", () => {
    it("filters diagnostics correctly by category", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 5000,
        proofStatus: "missing",
      });

      const treasuryDiag = getDiagnosticsByCategory(report, "treasury");
      const proofDiag = getDiagnosticsByCategory(report, "proof");
      const authDiag = getDiagnosticsByCategory(report, "auth");

      expect(treasuryDiag).toHaveLength(1);
      expect(proofDiag).toHaveLength(1);
      expect(authDiag).toHaveLength(0);
    });

    it("returns first actionable remediation", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 5000,
      });

      const remediation = getFirstRemediation(report);
      expect(remediation).toBeDefined();
      expect(remediation?.action).toBe("fund_treasury");
      expect(remediation?.label).toBe("Fund Treasury");
    });
  });

  describe("diagnosePayrollRun convenience helper", () => {
    it("diagnoses a PayrollRun domain object directly", () => {
      const mockRun: PayrollRun = {
        id: "run_domain_001",
        date: "2026-09-30",
        totalAmount: 18000,
        employeeCount: 4,
        status: "completed",
        type: "regular",
        txHash: "0xtxhash_mock",
        recipient: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        amount: 18000,
        employeeIds: ["emp_1", "emp_2", "emp_3", "emp_4"],
        proof: {
          circuit: "zk_payroll_v2",
          hash: "0xproof_hash_mock",
          timestamp: new Date().toISOString(),
          status: "verified",
        },
        approvalStatus: "approved",
      };

      const report = diagnosePayrollRun(mockRun, {
        treasuryBalance: 50000,
      });

      expect(report.runId).toBe("run_domain_001");
      expect(report.canExecute).toBe(true);
      expect(report.isBlocked).toBe(false);
    });

    it("detects missing proof on PayrollRun", () => {
      const mockRunWithoutProof: PayrollRun = {
        id: "run_domain_002",
        date: "2026-09-30",
        totalAmount: 18000,
        employeeCount: 4,
        status: "pending",
        type: "regular",
        txHash: "",
        recipient: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        amount: 18000,
        employeeIds: ["emp_1", "emp_2", "emp_3", "emp_4"],
        approvalStatus: "approved",
      };

      const report = diagnosePayrollRun(mockRunWithoutProof, {
        treasuryBalance: 50000,
      });

      expect(report.isBlocked).toBe(true);
      expect(hasExecutionBlocker(report, "PROOF_MISSING")).toBe(true);
    });
  });

  describe("Privacy & Diagnostic Bundle Serialization", () => {
    it("formats a clean, human-readable text report without leaking PII or raw secrets", () => {
      const report = diagnoseBlockedExecution({
        ...baseValidInput,
        treasuryBalance: 15000,
        proofStatus: "missing",
        isDuplicate: true,
      });

      const formatted = formatBlockedExecutionReport(report);

      expect(formatted).toContain("=== ZK Payroll Blocked Execution Diagnostics ===");
      expect(formatted).toContain("Status:        BLOCKED");
      expect(formatted).toContain("Blockers:      2");
      expect(formatted).toContain("Warnings:      1");
      expect(formatted).toContain("[TREASURY] TREASURY_INSUFFICIENT_FUNDS");
      expect(formatted).toContain("[PROOF] PROOF_MISSING");
      expect(formatted).toContain("[POLICY] DUPLICATE_EXECUTION");
      expect(formatted).toContain("Privacy Notice");

      // Verify privacy guarantees: no raw private keys or individual secrets
      expect(formatted).not.toContain("secret");
      expect(formatted).not.toContain("privateKey");
      expect(formatted).not.toContain("seed");
    });
  });
});
