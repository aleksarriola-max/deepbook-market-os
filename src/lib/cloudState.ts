import { supabase } from './supabase'

export type ItemKind = 'template' | 'predict_position'

export interface SavedItem<T> {
  id: number
  data: T
  createdAt: number
}

/** Lists saved items for a wallet/kind, newest first. Returns [] if cloud sync isn't configured. */
export async function listItems<T>(wallet: string, kind: ItemKind): Promise<SavedItem<T>[]> {
  if (!supabase || !wallet) return []
  const { data, error } = await supabase
    .from('saved_items')
    .select('id, data, created_at')
    .eq('wallet_address', wallet)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id as number,
    data: row.data as T,
    createdAt: new Date(row.created_at as string).getTime(),
  }))
}

/** Inserts one saved item. No-op if cloud sync isn't configured. */
export async function addItem<T>(wallet: string, kind: ItemKind, data: T): Promise<void> {
  if (!supabase || !wallet) return
  const { error } = await supabase.from('saved_items').insert({ wallet_address: wallet, kind, data })
  if (error) throw new Error(error.message)
}

/** Deletes one saved item by id. No-op if cloud sync isn't configured. */
export async function removeItem(id: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('saved_items').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
