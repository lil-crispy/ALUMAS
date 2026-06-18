<?php
$host = '72.62.166.253';
$db   = 'sistema_contable';
$user = 'sistema_user';
$pass = '12345';
$charset = 'utf8mb4';

if (!function_exists('alumas_debug_log')) {
    function alumas_debug_log($message, array $context = []) {
        $payload = '[ALUMINIO_DEBUG] ' . $message;
        if (!empty($context)) {
            $payload .= ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
        error_log($payload);
    }
}

$dsn = "mysql:host=$host;dbname=$db;charset=$charset";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
];

try {
    alumas_debug_log('db_connect_start', [
        'host' => $host,
        'db' => $db,
        'pdo_mysql_loaded' => extension_loaded('pdo_mysql'),
    ]);
    $pdo = new PDO($dsn, $user, $pass, $options);
    alumas_debug_log('db_connect_ok');
} catch (\PDOException $e) {
    alumas_debug_log('db_connect_fail', [
        'message' => $e->getMessage(),
        'code' => $e->getCode(),
    ]);
    // En producción, no mostrar el error detallado al usuario
    die("Error de conexión a la base de datos: " . $e->getMessage());
}
?>
