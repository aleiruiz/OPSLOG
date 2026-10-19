// Progressive enhancement of the demo-request form: without JavaScript it still posts normally.
(function () {
  'use strict';

  var form = document.querySelector('form.form');
  if (!form) return;
  var alertBox = form.querySelector('.form-alert');
  var button = form.querySelector('button[type="submit"]');

  var MESSAGES = {
    campos:
      'Revisa los campos marcados: nombre, empresa, un correo válido y el tamaño de tu flotilla son obligatorios, y debes aceptar el aviso de privacidad.',
    limite: 'Recibimos varias solicitudes desde tu conexión. Intenta de nuevo en unos minutos.',
    red: 'No pudimos enviar tu solicitud. Revisa tu conexión e intenta de nuevo.',
    formato: 'No pudimos leer tu solicitud. Intenta de nuevo.',
    tamano: 'Tu mensaje es demasiado largo.',
  };

  function show(message, success) {
    alertBox.textContent = message;
    alertBox.classList.toggle('success', Boolean(success));
    alertBox.hidden = false;
  }

  // Remember where the visitor came from (?utm_source=... or ?ref=...).
  var params = new URLSearchParams(window.location.search);
  var origin = params.get('utm_source') || params.get('ref') || '';
  form.elements.origen.value = origin.slice(0, 100);

  // Error sent back by the no-JavaScript fallback.
  var returned = params.get('error');
  if (returned) show(MESSAGES[returned] || MESSAGES.formato);

  function markInvalid(fields) {
    Array.prototype.forEach.call(form.elements, function (element) {
      if (element.name) element.removeAttribute('aria-invalid');
    });
    (fields || []).forEach(function (name) {
      var element = form.elements[name];
      if (element) element.setAttribute('aria-invalid', 'true');
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = {};
    Array.prototype.forEach.call(form.elements, function (element) {
      if (!element.name) return;
      data[element.name] = element.type === 'checkbox' ? element.checked : element.value;
    });
    button.disabled = true;
    fetch('/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (response.ok) {
            markInvalid([]);
            form.reset();
            form.elements.origen.value = origin.slice(0, 100);
            show(
              '¡Gracias! Recibimos tu solicitud y te contactaremos muy pronto para agendar la demo.',
              true,
            );
            return;
          }
          markInvalid(body.fields);
          show(MESSAGES[body.error] || MESSAGES.formato);
        });
      })
      .catch(function () {
        show(MESSAGES.red);
      })
      .then(function () {
        button.disabled = false;
        alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
  });
})();
