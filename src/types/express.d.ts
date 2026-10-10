declare global {
  namespace Express {
    interface Locals {
      anonymousSessionId?: string;
      admin?: { id: string; name: string; email: string };
      adminSessionId?: string;
    }
  }
}

export {};
