/**
 * 待复检来去回放（纯函数）
 * 以荫房记录为档案，按登记先后（createdAt，并列取 id）逐条重放：
 * - 越界记录（偏干 / 偏湿）挂起该胎体当时已登记且未完成的道次，并记下自己；
 * - 适宜记录按登记先后与最早一条未配对的越界记录「一条对一条」配对，
 *   只松下该越界记录挂起的那批道次，并记下是谁松的；
 * - 跨夜与同日都按登记先后各算一条，不按日期并算；
 * - 撤销记录后对剩余档案重新回放，被它挂起的道次自然回到没被它动过的样子。
 * 配对取「一条对一条」而非「每条越界各自等后头第一条适宜」：
 * 一一配对下每次挂起与每次松下都能回溯到唯一一条记录，撤销任意记录都可干净重放。
 */
import type { Coat } from '@/types/coat';
import type { Room } from '@/types/room';
import { ROOM_VERDICT_LABEL } from '@/types/room';

/** 回放后单道道次的待复检落点 */
export interface RecheckMark {
  needRecheck: boolean;
  recheckByRoomId: string | null;
  recheckReleasedByRoomId: string | null;
}

/** 单条荫房记录在回放中的来去 */
export interface RoomRecheckEffect {
  /** 越界记录：它挂起的道次 id */
  hungCoatIds: string[];
  /** 适宜记录：它松下的道次 id */
  releasedCoatIds: string[];
  /** 配对记录 id：越界记录指向松下它的适宜记录，适宜记录指向它结算的越界记录 */
  pairedWithRoomId: string | null;
}

export interface RecheckReplay {
  /** 道次 id → 待复检落点（覆盖传入的全部道次） */
  coatMarks: Record<string, RecheckMark>;
  /** 荫房记录 id → 来去效果（覆盖传入的全部记录） */
  roomEffects: Record<string, RoomRecheckEffect>;
}

export const EMPTY_RECHECK_MARK: RecheckMark = {
  needRecheck: false,
  recheckByRoomId: null,
  recheckReleasedByRoomId: null,
};

/** 登记先后排序：createdAt 优先，并列取 id，保证回放结果可重现 */
function byRegistration(a: Room, b: Room): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 回放单个胎体的荫房档案，推导每道道次的待复检来去与每条记录的挂 / 松效果。
 * rooms / coats 须同属一个胎体；函数内部自行排序，不依赖传入顺序。
 */
export function replayRecheck(rooms: Room[], coats: Coat[]): RecheckReplay {
  const orderedRooms = [...rooms].sort(byRegistration);
  const orderedCoats = [...coats].sort((a, b) => a.seq - b.seq);

  const hungBy = new Map<string, string>();
  const releasedBy = new Map<string, string>();
  const openOvers: string[] = [];
  const roomEffects: Record<string, RoomRecheckEffect> = {};

  for (const room of orderedRooms) {
    if (room.verdict === 'suitable') {
      // 一条对一条：只结算最早一条未配对的越界记录
      const target = openOvers.shift() ?? null;
      const releasedCoatIds: string[] = [];
      if (target !== null) {
        for (const coat of orderedCoats) {
          if (hungBy.get(coat.id) !== target) continue;
          hungBy.delete(coat.id);
          releasedBy.set(coat.id, room.id);
          releasedCoatIds.push(coat.id);
        }
        roomEffects[target].pairedWithRoomId = room.id;
      }
      roomEffects[room.id] = { hungCoatIds: [], releasedCoatIds, pairedWithRoomId: target };
      continue;
    }
    // 越界：挂起当时已登记且未完成的道次；已在挂的道次保持原挂起记录
    const hungCoatIds: string[] = [];
    for (const coat of orderedCoats) {
      if (coat.state === 'done') continue;
      if (coat.createdAt > room.createdAt) continue;
      if (hungBy.has(coat.id)) continue;
      hungBy.set(coat.id, room.id);
      releasedBy.delete(coat.id);
      hungCoatIds.push(coat.id);
    }
    openOvers.push(room.id);
    roomEffects[room.id] = { hungCoatIds, releasedCoatIds: [], pairedWithRoomId: null };
  }

  const coatMarks: Record<string, RecheckMark> = {};
  for (const coat of coats) {
    const hanger = hungBy.get(coat.id) ?? null;
    coatMarks[coat.id] = {
      needRecheck: hanger !== null,
      recheckByRoomId: hanger,
      recheckReleasedByRoomId: hanger === null ? (releasedBy.get(coat.id) ?? null) : null,
    };
  }
  return { coatMarks, roomEffects };
}

/** 待复检标签的悬浮说明：哪条记录挂起的 */
export function recheckHangNote(coat: Coat, rooms: Room[]): string | undefined {
  if (!coat.needRecheck) return undefined;
  const room = rooms.find((item) => item.id === coat.recheckByRoomId);
  return room
    ? `由 ${room.date} ${ROOM_VERDICT_LABEL[room.verdict]}记录挂起，待适宜记录配对松下`
    : '荫房越界记录挂起，待适宜记录配对松下';
}
