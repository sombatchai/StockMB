document.addEventListener('DOMContentLoaded', function() {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');

    if (menuToggle && sidebar) {
        // เมื่อมีการคลิกที่ปุ่มเมนู
        menuToggle.addEventListener('click', function() {
            // สลับคลาส 'open' เพื่อแสดง/ซ่อนเมนู
            sidebar.classList.toggle('open'); 
        });
    }
});