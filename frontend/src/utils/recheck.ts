/**
 * 待复检挂起 / 松绑配对算法
 * 以荫房登记先后为唯一时序：越界（偏干 / 偏湿）记录把该胎体「没完成的道次」挂起，
 * 后续登记的适宜记录把挂着的道次「松绑」。挂起与松绑都记下来源记录（谁挂的 / 谁松的）。
 *
 * 配法（可回溯到记录）：以越界记录为单位，每条越界各自等它登记之后的适宜记录。
 * 每条适宜记录按越界登记先后，找到最早一条「还挂着道次」的越界记录，松开其队列里
 * 按道次先后（seq）排最前的一道（一条对一条）；该越界名下挂了多道时，其余道次继续
 * 等后头的下一条适宜记录。这样每条越界与每条适宜的配对都唯一、可回溯；新增 / 编辑 /
 * 删除 / 撤销荫房记录后从档案整体重算即可还原，同日与跨夜都只按登记先后。
 */
import type { Coat } from '@/types/coat';
import type { Room } from '@/types/room';

/** 道次上一份挂起 / 松绑状态，字段全部可回溯到具体荫房记录 */
export interface RecheckState {
  /** 是否挂着待复检标记 */
  needRecheck: boolean;
  /** 挂起它的越界记录 id（谁挂的），未被挂起为 null */
  suspendedByRoomId: string | null;
  /** 松绑它的适宜记录 id（谁松的），尚未松绑为 null */
  releasedByRoomId: string | null;
}

/** 登记先后：同日与跨夜都一律按登记时刻（createdAt）排序，同刻再以 id 兜底保持稳定 */
export function roomsInRegistrationOrder(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

interface OverGroup {
  /** 挂起这批道次的越界记录 id */
  roomId: string;
  /** 该越界名下仍挂着的道次 id，按道次先后（seq）排队 */
  queue: string[];
}

/**
 * 重算单个胎体的全部道次挂起状态。
 * @param coats 该胎体的道次（以 state 判断「没完成」：state 非 done 即会被越界挂起）
 * @param rooms 该胎体的荫房记录（方法内部按登记先后排序）
 */
export function reconcileBodyRecheck(coats: Coat[], rooms: Room[]): Map<string, RecheckState> {
  /** 每条越界记录一个待松绑组，按越界登记先后排列 */
  const groups: OverGroup[] = [];
  /** 道次当前被哪条越界挂着（再次越界重挂时覆盖） */
  const suspendedBy = new Map<string, string>();
  /** 道次被哪条适宜松绑 */
  const releasedBy = new Map<string, string>();

  const coatsBySeq = [...coats].sort((a, b) => a.seq - b.seq);

  for (const room of roomsInRegistrationOrder(rooms)) {
    if (room.verdict !== 'suitable') {
      // 越界：把该胎体「没完成」且此刻没挂在别的越界名下的道次挂起，按道次先后排队并记下自己
      const ids: string[] = [];
      for (const coat of coatsBySeq) {
        const heldElsewhere = groups.some((group) => group.queue.includes(coat.id));
        if (coat.state !== 'done' && !heldElsewhere) {
          ids.push(coat.id);
          suspendedBy.set(coat.id, room.id);
        }
      }
      groups.push({ roomId: room.id, queue: ids });
    } else {
      // 适宜：按越界登记先后，取最早一条仍挂着道次的越界，松开其队首一道（一条对一条）
      const target = groups.find((group) => group.queue.length > 0);
      const coatId = target?.queue.shift();
      if (coatId !== undefined) {
        releasedBy.set(coatId, room.id);
      }
    }
  }

  /** 对账结束时仍挂着的道次集合 */
  const stillHeld = new Set<string>();
  groups.forEach((group) => group.queue.forEach((id) => stillHeld.add(id)));

  const result = new Map<string, RecheckState>();
  for (const coat of coats) {
    if (coat.state === 'done') {
      // 已完成的道次不再参与挂起：标记放下；完成时既有的挂起 / 松绑来源留作质检回溯
      result.set(coat.id, {
        needRecheck: false,
        suspendedByRoomId: suspendedBy.get(coat.id) ?? coat.suspendedByRoomId ?? null,
        releasedByRoomId: releasedBy.get(coat.id) ?? coat.releasedByRoomId ?? null,
      });
    } else {
      const held = stillHeld.has(coat.id);
      // 非完成道次完全以当前记录链为准：链里没有就清空来源，
      // 这样撤销越界记录后它就回到没被该记录动过的样子（不留残影）
      result.set(coat.id, {
        needRecheck: held,
        suspendedByRoomId: suspendedBy.get(coat.id) ?? null,
        releasedByRoomId: held ? null : (releasedBy.get(coat.id) ?? null),
      });
    }
  }
  return result;
}
