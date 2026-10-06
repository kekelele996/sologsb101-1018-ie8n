/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计；记录增删改后按登记先后回放该胎体荫房档案：
 * 越界记录挂起未完成道次并自记，适宜记录一条对一条配对松下，撤销记录即复原。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { replayRecheck, type RecheckReplay } from '@/utils/recheck';
import { useCoatStore } from './coatStore';

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<Room>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 回放该胎体荫房档案，重算道次待复检来去并落库 */
  recomputeRecheck: (bodyId: string) => Promise<RecheckReplay>;
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
      rooms.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      set({ rooms, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '荫房记录读取失败' });
    }
  },

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const row: Room = { ...draft, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    // 越界挂起 / 适宜配对松下：登记后立即回放该胎体档案
    await get().recomputeRecheck(row.bodyId);
    await get().loadRooms();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    await db.rooms.update(id, { ...patch, tempC, humidityPct, verdict, updatedAt: Date.now() } as never);
    await get().recomputeRecheck(existing.bodyId);
    if (patch.bodyId && patch.bodyId !== existing.bodyId) {
      await get().recomputeRecheck(patch.bodyId);
    }
    await get().loadRooms();
  },

  async removeRoom(id) {
    const existing = await db.rooms.get(id);
    await db.rooms.delete(id);
    // 撤销记录后重放剩余档案，被它挂起的道次回到没被它动过的样子
    if (existing) await get().recomputeRecheck(existing.bodyId);
    await get().loadRooms();
  },

  async recomputeRecheck(bodyId) {
    const [rooms, coats] = await Promise.all([
      db.rooms.where('bodyId').equals(bodyId).toArray(),
      db.coats.where('bodyId').equals(bodyId).toArray(),
    ]);
    const replay = replayRecheck(rooms, coats);
    await useCoatStore.getState().applyRecheckMarks(bodyId, replay.coatMarks);
    return replay;
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
