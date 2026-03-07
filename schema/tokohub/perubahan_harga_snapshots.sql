CREATE TABLE IF NOT EXISTS tokohub.perubahan_harga_snapshots (
  id INT(11) NOT NULL AUTO_INCREMENT,
  ph_number VARCHAR(30) NOT NULL,
  becreff INT(11) NOT NULL DEFAULT 0,
  artno VARCHAR(30) NOT NULL,
  artname VARCHAR(200) NOT NULL DEFAULT '',
  tanggal DATE NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_by VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ph_number_idx (ph_number),
  KEY tanggal_idx (tanggal)
) ENGINE=MyISAM DEFAULT CHARSET=latin1;
