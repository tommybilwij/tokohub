"""Pydantic models for receipt endpoints."""

from pydantic import BaseModel


class ReceiptItem(BaseModel):
    name: str = ''
    barcode: str = ''
    qty: float = 1
    price: float = 0


class MatchRequest(BaseModel):
    items: list[ReceiptItem]


class AliasCreate(BaseModel):
    alias_name: str
    artno: str
    userid: str = 'RECEIPT_APP'


class AliasDelete(BaseModel):
    id: int


class FPItem(BaseModel):
    artno: str
    qty: float
    price_override: float | None = None
    packing_override: float | None = None
    disc1_override: float | None = None
    disc2_override: float | None = None
    disc3_override: float | None = None
    ppn_override: float | None = None
    hjual1_override: float | None = None
    hjual2_override: float | None = None
    hjual3_override: float | None = None
    hjual4_override: float | None = None
    hjual5_override: float | None = None
    qty_besar: float | None = None
    satuan_bsr: str | None = None
    foc: int = 0
    shipping_cost: float = 0
    bundling1: dict | None = None
    bundling2: dict | None = None


class FPPreviewRequest(BaseModel):
    supplier_id: str
    items: list[FPItem]
    order_date: str | None = None
    due_date: str | None = None
    uraian: str | None = None
    shipping_cost: float = 0  # legacy total fallback


class FPCommitRequest(BaseModel):
    supplier_id: str
    userid: str
    items: list[FPItem]
    order_date: str | None = None
    due_date: str | None = None
    uraian: str | None = None
    shipping_cost: float = 0  # legacy total fallback
    update_price: bool = True


class FPUpdateRequest(BaseModel):
    fp_number: str
    supplier_id: str
    userid: str
    items: list[FPItem]
    order_date: str | None = None
    due_date: str | None = None
    uraian: str | None = None
    shipping_cost: float = 0
    update_price: bool = True
