import { z } from 'zod';

const ANALYSIS_REPORT_SCHEMA_VERSION = '1.0.0' as const;

const CompatibleAnalysisReportIssueSchema = z
  .object({
    issue: z.string().min(1),
    recommendation: z.string().optional(),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    wafPillar: z.string().optional(),
    findingClass: z.string().optional(),
    foundBy: z.string().optional(),
  })
  .passthrough();

const CompatibleAnalysisReportRecommendationSchema = z
  .object({
    resourceId: z.string().min(1),
    logicalId: z.string().optional(),
    issues: z.array(CompatibleAnalysisReportIssueSchema),
  })
  .passthrough();

const CompatibleAnalysisReportSummarySchema = z
  .object({
    totalIssues: z.number().int().nonnegative().optional(),
    totalResources: z.number().int().nonnegative().optional(),
    severityCounts: z
      .object({
        CRITICAL: z.number().int().nonnegative().optional(),
        HIGH: z.number().int().nonnegative().optional(),
        MEDIUM: z.number().int().nonnegative().optional(),
        LOW: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * Public Action reader for the stable v1 analysis-report wire format.
 *
 * The canonical writer schemas remain in cdk-insights-contract. Keeping this
 * compatible reader local prevents public Action builds from requiring access
 * to a private npm package while retaining strict validation at the boundary.
 */
export const CompatibleAnalysisReportSchema = z
  .object({
    schemaVersion: z.literal(ANALYSIS_REPORT_SCHEMA_VERSION).optional(),
    stackName: z.string().min(1).optional(),
    generatedAt: z.string().datetime().optional(),
    version: z.string().min(1).optional(),
    summary: CompatibleAnalysisReportSummarySchema.optional(),
    recommendations: z
      .array(CompatibleAnalysisReportRecommendationSchema)
      .optional(),
  })
  .passthrough()
  .refine((report) => report.summary || report.recommendations, {
    message: 'Report must contain summary or recommendations',
  });
