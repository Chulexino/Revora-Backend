import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface ContractUpgradeInput {
  contractId: string;
  wasmHash: string;
  requestedBy: string;
}

export interface ContractUpgradeService {
  requestUpgrade(input: ContractUpgradeInput): Promise<Record<string, unknown>>;
}

interface CreateContractUpgradeRouterDependencies {
  requireAuth: RequestHandler;
  contractUpgradeService: ContractUpgradeService;
}

const contractIdPattern = /^C[A-Z2-7]{55}$/;
const wasmHashPattern = /^[A-Fa-f0-9]{64}$/;

const getUserId = (req: Request): string | undefined => {
  const fromAuth = (req as any).auth?.userId;
  const fromUser = (req as any).user?.id ?? (req as any).user?.sub;
  return fromAuth ?? fromUser;
};

export const createContractUpgradeRouter = ({
  requireAuth,
  contractUpgradeService,
}: CreateContractUpgradeRouterDependencies): Router => {
  const router = Router();

  router.post(
    '/contracts/:contractId/upgrade',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { contractId } = req.params;
      const wasmHash = req.body?.wasmHash;

      if (!contractIdPattern.test(contractId)) {
        res.status(400).json({ error: 'Invalid contract ID' });
        return;
      }

      if (typeof wasmHash !== 'string' || !wasmHashPattern.test(wasmHash)) {
        res.status(400).json({ error: 'Invalid WASM hash' });
        return;
      }

      const requestedBy = getUserId(req);
      if (!requestedBy) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      try {
        const upgrade = await contractUpgradeService.requestUpgrade({
          contractId,
          wasmHash: wasmHash.toLowerCase(),
          requestedBy,
        });
        res.status(202).json({ data: upgrade });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
};