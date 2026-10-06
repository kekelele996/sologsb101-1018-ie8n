/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计；越界记录挂起关联道次、适宜记录松绑，
 * 挂起 / 松绑均按登记先后对账落库并记录来源（谁挂的 / 谁松的）。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { reconcileRecheck, type RecheckSyncResult } from '@/utils/recheckSync';
import { useCoatStore } from './coatStore';

export interface RoomChangeResult {
  room: Room;
  sync: RecheckSyncResult;
}

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<RoomChangeResult>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<RoomChangeResult | null>;
  removeRoom: (id: string) => Promise<RecheckSyncResult>;
  /** 超标（偏干 / 偏湿）记录条数 */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  rooms: [],
  loading: false,
  ready: false,
  error: '',

  async loadRooms() {
    set({ loading: true });
    try {
      const rooms = await db.rooms.toArray();
      rooms.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      set({ rooms, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '荫房记录读取失败' });
    }
  },

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const row: Room = { ...draft, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    // 依据登记先后对账：越界挂起、适宜松绑，并记录来源
    const sync = await reconcileRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
    return { room: row, sync };
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return null;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    const next: Room = {
      ...existing,
      ...patch,
      tempC,
      humidityPct,
      verdict,
      updatedAt: Date.now(),
    };
    await db.rooms.put(next);
    // 编辑（含改判定 / 改登记时间）后整体重算，挂起来源随之迁移
    const sync = await reconcileRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
    return { room: next, sync };
  },

  async removeRoom(id) {
    // 撤销：删掉该记录后重算，被它挂起（且后续无记录接手）的道次回到没被它动过的样子
    await db.rooms.delete(id);
    const sync = await reconcileRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
    return sync;
  },

  overCount() {
    return get().rooms.filter((room) => room.verdict !== 'suitable').length;
  },

  overCountOfBody(bodyId) {
    return get().rooms.filter((room) => room.bodyId === bodyId && room.verdict !== 'suitable').length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    get().rooms.forEach((room) => {
      result[room.verdict] += 1;
    });
    return result;
  },
}));
