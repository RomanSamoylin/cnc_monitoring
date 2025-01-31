// Пример с использованием localStorage для "Запомнить меня"
document.getElementById("loginForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const rememberMe = document.getElementById("rememberMe").checked; // Добавьте чекбокс "Запомнить меня"

    if (username === "admin" && password === "victoria123") {
        if (rememberMe) {
            localStorage.setItem("username", username); // Сохраняем логин
        } else {
            localStorage.removeItem("username"); // Удаляем логин
        }
        window.location.href = "dashboard.html";
    } else {
        document.getElementById("errorMessage").style.display = "block";
    }
});

// При загрузке страницы проверяем сохраненный логин
window.onload = function () {
    const savedUsername = localStorage.getItem("username");
    if (savedUsername) {
        document.getElementById("username").value = savedUsername;
    }
};
