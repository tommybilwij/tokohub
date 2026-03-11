CREATE TABLE IF NOT EXISTS tokohub.pesanan_pembelian (
  id INT(11) NOT NULL AUTO_INCREMENT,
  po_number VARCHAR(30) NOT NULL,
  suppid VARCHAR(30) NOT NULL,
  tgl_pesanan DATE NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  total_items INT NOT NULL DEFAULT 0,
  keterangan VARCHAR(200) NOT NULL DEFAULT '',
  created_by VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY po_number_idx (po_number),
  KEY suppid_idx (suppid)
) ENGINE=MyISAM DEFAULT CHARSET=latin1;

CREATE TABLE IF NOT EXISTS tokohub.pesanan_pembelian_detail (
  id INT(11) NOT NULL AUTO_INCREMENT,
  po_number VARCHAR(30) NOT NULL,
  artno VARCHAR(30) NOT NULL,
  artpabrik VARCHAR(30) NOT NULL DEFAULT '',
  artname VARCHAR(200) NOT NULL DEFAULT '',
  packing DECIMAL(20,4) NOT NULL DEFAULT 1,
  satbesar VARCHAR(30) NOT NULL DEFAULT '',
  satkecil VARCHAR(30) NOT NULL DEFAULT '',
  qty_order DECIMAL(20,4) NOT NULL DEFAULT 0,
  qty_order_kcl DECIMAL(20,4) NOT NULL DEFAULT 0,
  hbelibsr DECIMAL(20,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY po_number_idx (po_number),
  KEY artno_idx (artno)
) ENGINE=MyISAM DEFAULT CHARSET=latin1;
