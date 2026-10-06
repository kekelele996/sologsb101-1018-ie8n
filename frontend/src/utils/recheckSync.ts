/**
 * 待复检对账落库
 * 依据当前全部荫房记录（档案）重算道次挂起状态，并把变化写回 coats 表。
 * 新增 / 编辑 / 删除荫房记录、道次状态推进或删除道次后都调用它，
 * 使「待复检」随时与档案一致，且撤销荫房记录能让道次回到没被它动过的样子。
 */
import { db } from './db';
import { reconcileBodyRecheck } from './recheck';
import type { Coat } from '@/types/coat';

export interface RecheckSyncResult {
  /** 实际写回的道次数 */
  changedCoats: number;
  /** 对账后仍挂着待复检的道次数 */
  heldCount: number;
  /** 本次由不挂变为挂起的道次 id（被挂起） */
  newlySuspendedCoatIds: string[];
  /** 本次由挂着变为放下的道次 id（被松绑或已完成） */
  newlyReleasedCoatIds: string[];
}

/** 全量重算并落库；数据量为单工作室规模，每次整体对账简单且可回溯 */
export async function reconcileRecheck(): Promise<RecheckSyncResult> {
  const [coats, rooms] = await Promise.all([db.coats.toArray(), db.rooms.toArray()]);

  const byBody = new Map<string, Coat[]>();
  for (const coat of coats) {
    const list = byBody.get(coat.bodyId) ?? [];
    list.push(coat);
    byBody.set(coat.bodyId, list);
  }

  const updates: Coat[] = [];
  const newlySuspendedCoatIds: string[] = [];
  const newlyReleasedCoatIds: string[] = [];
  let heldCount = 0;

  for (const [bodyId, bodyCoats] of byBody) {
    const states = reconcileBodyRecheck(bodyCoats, rooms.filter((room) => room.bodyId === bodyId));
    for (const coat of bodyCoats) {
      const next = states.get(coat.id);
      if (!next) continue;
      if (next.needRecheck) heldCount += 1;
      const wasHeld = coat.needRecheck;
      if (!wasHeld && next.needRecheck) newlySuspendedCoatIds.push(coat.id);
      if (wasHeld && !next.needRecheck) newlyReleasedCoatIds.push(coat.id);
      const changed =
        coat.needRecheck !== next.needRecheck ||
        coat.suspendedByRoomId !== next.suspendedByRoomId ||
        coat.releasedByRoomId !== next.releasedByRoomId;
      if (changed) {
        updates.push({
          ...coat,
          needRecheck: next.needRecheck,
          suspendedByRoomId: next.suspendedByRoomId,
          releasedByRoomId: next.releasedByRoomId,
          updatedAt: Date.now(),
        });
      }
    }
  }

  if (updates.length > 0) {
    await db.coats.bulkPut(updates);
  }

  return {
    changedCoats: updates.length,
    heldCount,
    newlySuspendedCoatIds,
    newlyReleasedCoatIds,
  };
}
