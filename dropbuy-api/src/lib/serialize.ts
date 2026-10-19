import type { User, Address, Shop } from '@prisma/client';
import { prisma } from './db.js';

export async function locationNames(ids: number[]) {
  const rows = ids.length ? await prisma.location.findMany({ where: { id: { in: [...new Set(ids)] } } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function profileOf(u: User) {
  const parent = u.parent_user_id ? await prisma.user.findUnique({ where: { id: u.parent_user_id }, select: { phone: true } }) : null;
  return {
    user_id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    link_fb: u.link_fb,
    fullname: u.fullname,
    default_address: u.default_address,
    cccd: u.cccd,
    status: u.status,
    bank_ref_user_code: u.bank_ref_user_code,
    created_at: u.created_at,
    parent_user_id: u.parent_user_id,
    parent_phone: parent?.phone ?? null,
    tenant_id: u.tenant_id,
    user_level: u.user_level,
    mfa_enabled: u.mfa_enabled,
    mfa_enabled_at: u.mfa_enabled_at,
    vat_info: u.vat_info,
    is_sa: u.is_sa,
  };
}

export async function addressesOut(rows: Address[]) {
  const names = await locationNames(rows.flatMap((a) => [a.province_id, a.district_id, a.ward_id]));
  return rows.map((a) => ({
    unique_id: a.unique_id,
    id: a.id,
    user_id: a.user_id,
    fullname: a.fullname,
    phone: a.phone,
    address_line: a.address_line,
    province_id: a.province_id,
    province_name: names.get(a.province_id) ?? null,
    district_id: a.district_id,
    district_name: names.get(a.district_id) ?? null,
    ward_id: a.ward_id,
    ward_name: names.get(a.ward_id) ?? null,
    is_default: a.is_default,
    note: a.note,
    created_at: a.created_at,
  }));
}

export function shopOut(s: Shop) {
  return {
    id: s.id,
    user_id: s.user_id,
    name: s.name,
    display_name: s.display_name,
    created_at: s.created_at,
    status: s.status,
    admin_status: s.admin_status,
    updated_at: s.updated_at,
    notes: s.notes,
    enable_virtual_depot: s.enable_virtual_depot,
    is_mall: s.is_mall,
    link_fb: s.link_fb,
    fullname: s.fullname,
    phone: s.phone,
    address_line: s.address_line,
    province_id: s.province_id,
    district_id: s.district_id,
    ward_id: s.ward_id,
    avatar_url: s.avatar_url,
    banner_url: s.banner_url,
    description: s.description,
    reputation_score: s.reputation_score,
  };
}
