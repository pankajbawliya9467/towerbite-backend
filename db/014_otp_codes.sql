-- Login codes made by our API (the SMS service only delivers them). One live code per number; only a
-- salted hash is stored. Safe to re-run.
create table if not exists otp_codes (
  phone text primary key,
  salt text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists otp_codes_expiry_idx on otp_codes (expires_at);
alter table otp_codes enable row level security;
