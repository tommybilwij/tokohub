CREATE TABLE IF NOT EXISTS tokohub.role_permissions (
  role VARCHAR(20) NOT NULL,
  permissions VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (role)
) ENGINE=MyISAM DEFAULT CHARSET=latin1;

INSERT IGNORE INTO tokohub.role_permissions (role, permissions)
VALUES ('karyawan', 'scanner');
