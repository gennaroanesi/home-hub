// The one Amplify data client the finance pages share (Cognito user pool).
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

export const financeClient = generateClient<Schema>({ authMode: "userPool" });

export type FinanceAccount = Schema["homeFinanceAccount"]["type"];
export type FinanceTransaction = Schema["homeFinanceTransaction"]["type"];
export type FinanceSchedule = Schema["homeFinanceRecurring"]["type"];
export type FinanceBudget = Schema["homeFinanceBudget"]["type"];
export type FinanceGoal = Schema["homeFinanceSavingsGoal"]["type"];
export type FinanceSpendGroup = Schema["homeFinanceSpendGroup"]["type"];
export type FinanceCategoryRule = Schema["homeFinanceCategoryRule"]["type"];
export type FinanceSyncLog = Schema["homeFinanceSyncLog"]["type"];
export type FinanceSnapshot = Schema["homeFinanceAccountSnapshot"]["type"];
