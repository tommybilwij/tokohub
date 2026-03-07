CREATE TABLE IF NOT EXISTS tokohub.faktur_pembelian_snapshots (
  id INT(11) NOT NULL AUTO_INCREMENT,
  po_number VARCHAR(30) NOT NULL,
  snapshot_json MEDIUMTEXT NOT NULL,
  created_by VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY po_number_idx (po_number)
) ENGINE=MyISAM DEFAULT CHARSET=latin1;
