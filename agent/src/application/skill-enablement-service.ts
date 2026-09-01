import { MysqlDependencyError } from '../infrastructure/mysql/errors.js';

export async function mutateSkillWithLedger(input: {
  action: 'enable' | 'disable';
  name: string;
  owner: { orgId: string; userId: string };
  manager: {
    enable: (input: { name: string }) => Promise<any>;
    disable: (input: { name: string }) => Promise<any>;
  };
  ledger: {
    upsert: (input: Record<string, any>) => Promise<void>;
    remove: (name: string, owner: { orgId: string; userId: string }) => Promise<void>;
  };
}) {
  if (input.action === 'disable') {
    const result = await input.manager.disable({ name: input.name });
    await input.ledger.remove(input.name, input.owner);
    return result;
  }

  const result = await input.manager.enable({ name: input.name });
  try {
    await input.ledger.upsert({
      ...input.owner,
      ...result,
      enabledByUserId: input.owner.userId,
    });
    return result;
  } catch (error) {
    // MySQL is the durable enablement authority: no row means no published package.
    await input.manager.disable({ name: input.name });
    throw new MysqlDependencyError('Skill enablement ledger update failed', { cause: error });
  }
}
